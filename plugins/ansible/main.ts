/**
 * Ansible playbooks from Castor. The playbooks themselves run on agents (the `ansible` tool and the
 * commands in library/); this code answers two hooks (docs/PLUGINS.md, "Hooks"):
 *
 * - job.prepare: just before one of its commands is sent, the inventory (the project's hosts, by the
 *   card's targets or filter and scope, with what Castor knows of them as host variables), the
 *   callback that writes what each task did on each host, and the extra vars ("{}" when there are none).
 * - assets.map: after a run, the facts each reachable host reported, as the project's hosts.
 *
 * Sandboxed; no network. It reads the project's hosts and services through Castor's API.
 */
import { type AssetsMapCall, definePlugin, type JobPrepareCall } from "@castor/plugin";
import { buildInventory, type HostAsset, type ServiceAsset } from "./inventory.ts";

/** Written into the job (input `callback`) and enabled by the commands: a notification callback,
 *  so the console keeps Ansible's usual output, that writes the results to $CASTOR_RESULTS. */
export const CALLBACK = `# castor_results: what each task did on each host, and the facts hosts reported, as JSON at
# $CASTOR_RESULTS for Castor's parsers (the Ansible plugin's ansible-results and ansible-hosts).
from __future__ import annotations

import json
import os
import time

from ansible.plugins.callback import CallbackBase

FACTS = ("distribution", "distribution_version", "os_family", "hostname", "fqdn", "domain", "kernel",
         "architecture", "default_ipv4", "all_ipv4_addresses", "dns", "virtualization_type", "system")


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "aggregate"
    CALLBACK_NAME = "castor_results"
    CALLBACK_NEEDS_ENABLED = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.results = []
        self.facts = {}
        self.play = ""
        self.started = {}

    def v2_playbook_on_play_start(self, play):
        self.play = play.get_name()

    def v2_playbook_on_task_start(self, task, is_conditional):
        self.started[task._uuid] = time.time()

    def _add(self, result, status):
        task = result._task
        data = result._result or {}
        host = result._host.get_name()
        facts = data.get("ansible_facts") or {}
        if facts:
            short = {(k[8:] if k.startswith("ansible_") else k): v for k, v in facts.items()}
            self.facts.setdefault(host, {}).update({k: short[k] for k in FACTS if k in short})
        msg = data.get("msg") or data.get("stderr") or ""
        if not isinstance(msg, str):
            msg = json.dumps(msg, default=str)
        self.results.append({
            "host": host, "play": self.play, "task": task.get_name(), "action": task.action, "status": status,
            "changed": bool(data.get("changed")), "msg": msg[:2000], "rc": data.get("rc"),
            "duration": round(time.time() - self.started.get(task._uuid, time.time()), 3),
        })

    def v2_runner_on_ok(self, result):
        self._add(result, "changed" if (result._result or {}).get("changed") else "ok")

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self._add(result, "ignored" if ignore_errors else "failed")

    def v2_runner_on_unreachable(self, result):
        self._add(result, "unreachable")

    def v2_runner_on_skipped(self, result):
        self._add(result, "skipped")

    def v2_playbook_on_stats(self, stats):
        path = os.environ.get("CASTOR_RESULTS")
        if not path:
            return
        hosts = {}
        for host in sorted(stats.processed.keys()):
            s = stats.summarize(host)
            hosts[host] = {"ok": s["ok"], "changed": s["changed"], "failed": s["failures"], "unreachable": s["unreachable"],
                           "skipped": s["skipped"], "rescued": s.get("rescued", 0), "ignored": s.get("ignored", 0),
                           "facts": self.facts.get(host, {})}
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as out:
            json.dump({"version": 1, "results": self.results, "hosts": hosts}, out, default=str)
`;

const PAGE = 500;
const MOST = 5000;

interface AssetList<T> {
  items: T[];
  total: number;
}

async function allOf<T>(get: (offset: number) => Promise<AssetList<T>>): Promise<T[]> {
  const out: T[] = [];
  while (out.length < MOST) {
    const page = await get(out.length);
    out.push(...page.items);
    if (page.items.length < PAGE || out.length >= page.total) break;
  }
  return out;
}

const words = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : []);

definePlugin({
  activate(ctx) {
    ctx.hooks.on("job.prepare", async (call: JobPrepareCall) => {
      const a = call.args;
      const inputs: Record<string, string> = { callback: CALLBACK };
      // An empty extra-vars file isn't valid to Ansible: "{}" when the card gives none.
      inputs.extra = words(call.inputs.extra) || "{}";
      if (!words(a.inventory_path)) {
        const project = call.project.id;
        const targets = list(a.targets);
        const query = (type: string) => (offset: number) =>
          ctx.api.get<AssetList<HostAsset>>(`/api/projects/${project}/assets`, {
            type, limit: PAGE, offset,
            // Targets are matched against every host; otherwise the card's filter and scope choose them.
            ...(type === "host" && !targets.length ? { where: words(a.asset_filter), ...(words(a.scope) ? { scope: words(a.scope) } : {}) } : {}),
          });
        const hosts = await allOf(query("host"));
        const services = (await allOf(query("service"))) as ServiceAsset[];
        const inventory = buildInventory(hosts, services, targets);
        if (!Object.keys(inventory.all.hosts).length) {
          throw new Error(targets.length ? "no targets to run on" : "the project has no hosts that match: add some, or give targets");
        }
        call.log.info(`inventory: ${Object.keys(inventory.all.hosts).length} host(s) for ${call.card.title}`);
        // JSON is YAML: inventory.yml with Ansible's YAML inventory plugin.
        inputs.inventory = JSON.stringify(inventory, null, 2);
      }
      return { inputs };
    });

    ctx.hooks.on("assets.map", (call: AssetsMapCall) => {
      const rows = Array.isArray(call.value) ? (call.value as Record<string, unknown>[]) : [];
      const assets = [];
      for (const [i, r] of rows.entries()) {
        if (r.status === "unreachable") continue; // it said nothing about itself
        const fields: Record<string, unknown> = {};
        const named = words(r.host);
        const ip = words(r.ip) || (/^\d{1,3}(\.\d{1,3}){3}$/.test(named) ? named : "");
        if (ip) fields.ip = ip;
        const hostname = words(r.hostname) || (!ip || named !== ip ? named : "");
        if (hostname && hostname !== ip) fields.hostname = hostname;
        for (const key of ["os", "domain", "mac", "gateway"]) if (words(r[key])) fields[key] = r[key];
        if (list(r.dns_servers).length) fields.dns_servers = list(r.dns_servers);
        fields.status = "up";
        if (fields.ip || fields.hostname) assets.push({ ref: `h${i}`, type: "host", fields });
      }
      return { assets };
    });
  },
});
