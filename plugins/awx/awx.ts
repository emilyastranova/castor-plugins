/**
 * Talking to AWX / Ansible Automation Platform (its REST API, /api/v2 or AAP's controller path) and
 * turning its answers into Castor's terms. No Castor SDK here, so it's tested on its own (awx_test.ts)
 * with a fake API.
 */

export interface AwxSettings {
  url: string;
  token: string;
  poll_seconds?: number;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class AwxError extends Error {}

/** What a card asks of a job template (the action's arguments). */
export interface LaunchArgs {
  template: string;
  inventory?: string;
  limit?: string;
  extra_vars?: string;
  job_tags?: string;
  skip_tags?: string;
  check?: boolean;
  diff?: boolean;
}

/** One task on one host, like the Ansible plugin's castor_results rows. */
export interface ResultRow {
  host: string;
  play: string;
  task: string;
  action: string;
  status: "ok" | "changed" | "failed" | "unreachable" | "skipped" | "ignored";
  changed: boolean;
  msg: string;
  rc: number | null;
  duration: number | null;
}

export interface HostRow {
  host: string;
  status: "ok" | "changed" | "failed" | "unreachable";
  ok: number;
  changed: number;
  failed: number;
  unreachable: number;
  skipped: number;
  rescued: number;
  ignored: number;
}

export interface AwxEvent {
  counter: number;
  event: string;
  stdout?: string;
  host_name?: string;
  failed?: boolean;
  changed?: boolean;
  event_data?: Record<string, unknown>;
}

/** Which of the template's launch prompts each argument needs ("Prompt on launch" in AWX). */
const PROMPTS: [keyof LaunchArgs, string, string][] = [
  ["inventory", "ask_inventory_on_launch", "Inventory"],
  ["limit", "ask_limit_on_launch", "Limit"],
  ["extra_vars", "ask_variables_on_launch", "Variables"],
  ["job_tags", "ask_tags_on_launch", "Job tags"],
  ["skip_tags", "ask_skip_tags_on_launch", "Skip tags"],
  ["check", "ask_job_type_on_launch", "Job type"],
  ["diff", "ask_diff_mode_on_launch", "Show changes"],
];

const given = (v: unknown) => v !== undefined && v !== null && v !== "" && v !== false;

/** The launch request for these arguments, refusing any the template won't take: a check run whose
 *  job type AWX ignored would change things for real, a retry whose limit it ignored would run on
 *  every host. */
export function launchBody(args: LaunchArgs, prompts: Record<string, unknown>, inventoryId?: number): Record<string, unknown> {
  const refused = PROMPTS.filter(([arg, ask]) => given(args[arg]) && prompts[ask] !== true).map(([, , label]) => label);
  if (refused.length) {
    throw new AwxError(`the job template doesn't prompt on launch for ${refused.join(", ")}: turn "Prompt on launch" on for ${refused.length === 1 ? "it" : "them"} in AWX, or leave ${refused.length === 1 ? "it" : "them"} empty here`);
  }
  const body: Record<string, unknown> = {};
  if (inventoryId !== undefined) body.inventory = inventoryId;
  if (given(args.limit)) body.limit = String(args.limit);
  if (given(args.extra_vars)) body.extra_vars = String(args.extra_vars);
  if (given(args.job_tags)) body.job_tags = String(args.job_tags);
  if (given(args.skip_tags)) body.skip_tags = String(args.skip_tags);
  if (args.check) body.job_type = "check";
  if (args.diff) body.diff_mode = true;
  return body;
}

/** A job event as a results row (null for events that aren't a task's result on a host). */
export function rowOf(ev: AwxEvent): ResultRow | null {
  const status = ({
    runner_on_ok: "ok", runner_on_failed: "failed", runner_on_unreachable: "unreachable", runner_on_skipped: "skipped",
  } as Record<string, ResultRow["status"]>)[ev.event];
  if (!status || !ev.host_name) return null;
  const d = ev.event_data ?? {};
  const res = (d.res ?? {}) as Record<string, unknown>;
  const changed = Boolean(res.changed ?? ev.changed);
  let final = status;
  if (status === "ok" && changed) final = "changed";
  if (status === "failed" && d.ignore_errors) final = "ignored";
  let msg = res.msg ?? res.stderr ?? "";
  if (typeof msg !== "string") msg = JSON.stringify(msg);
  return {
    host: ev.host_name, play: String(d.play ?? ""), task: String(d.task ?? ""), action: String(d.task_action ?? ""),
    status: final, changed, msg: (msg as string).slice(0, 2000), rc: typeof res.rc === "number" ? res.rc : null,
    duration: typeof d.duration === "number" ? Math.round(d.duration * 1000) / 1000 : null,
  };
}

/** The recap (the playbook_on_stats event) as one row per host. */
export function hostsOf(stats: Record<string, unknown>): HostRow[] {
  const count = (k: string, h: string) => Number(((stats[k] ?? {}) as Record<string, number>)[h] ?? 0);
  const names = new Set<string>();
  for (const k of ["ok", "changed", "failures", "dark", "skipped", "rescued", "ignored", "processed"]) {
    for (const h of Object.keys((stats[k] ?? {}) as Record<string, number>)) names.add(h);
  }
  return [...names].sort().map((host) => {
    const r = {
      host, ok: count("ok", host), changed: count("changed", host), failed: count("failures", host), unreachable: count("dark", host),
      skipped: count("skipped", host), rescued: count("rescued", host), ignored: count("ignored", host),
    };
    return { ...r, status: r.unreachable ? "unreachable" : r.failed ? "failed" : r.changed ? "changed" : "ok" } as HostRow;
  });
}

/** An inventory's hosts (AWX's inventory script: ansible-inventory --list's shape) as the rows Castor
 *  adds as SSH hosts: {name, host, port, user, groups, skip}. */
export function inventoryRows(script: Record<string, unknown>): Record<string, unknown>[] {
  const hostvars = ((script._meta ?? {}) as { hostvars?: Record<string, Record<string, unknown>> }).hostvars ?? {};
  const parents: Record<string, string[]> = {};
  const member: Record<string, string[]> = {};
  const names = Object.keys(hostvars);
  for (const [group, body] of Object.entries(script)) {
    if (group === "_meta" || !body || typeof body !== "object") continue;
    const b = (Array.isArray(body) ? { hosts: body } : body) as { hosts?: string[]; children?: string[] };
    for (const child of b.children ?? []) (parents[child] ??= []).push(group);
    for (const host of b.hosts ?? []) {
      (member[host] ??= []).push(group);
      if (!names.includes(host)) names.push(host);
    }
  }
  const lineage = (g: string, seen: string[]): string[] => [g, ...(parents[g] ?? []).filter((p) => !seen.includes(p)).flatMap((p) => lineage(p, [...seen, g]))];
  const ssh = ["ssh", "smart", "paramiko", "ansible.builtin.ssh", "ansible.builtin.paramiko_ssh"];
  return names.map((name) => {
    const v = hostvars[name] ?? {};
    const connection = String(v.ansible_connection ?? "ssh");
    const port = v.ansible_port ?? v.ansible_ssh_port;
    return {
      name,
      host: String(v.ansible_host ?? v.ansible_ssh_host ?? name),
      port: port === undefined || port === null || port === "" ? null : Number(port),
      user: String(v.ansible_user ?? v.ansible_ssh_user ?? ""),
      groups: [...new Set((member[name] ?? []).flatMap((g) => lineage(g, [])))].filter((g) => g !== "all" && g !== "ungrouped").sort(),
      skip: ssh.includes(connection) ? null : `it connects with ${connection}, not SSH`,
    };
  });
}

export class Awx {
  #base: string;

  constructor(private s: AwxSettings, private fetcher: Fetch = fetch) {
    if (!s.url) throw new AwxError("No AWX URL: set it in the plugin's settings");
    if (!s.token) throw new AwxError("No AWX token: set one in the plugin's settings (or your own, under Your plugin settings)");
    // AWX answers at /api/v2; AAP 2.5's gateway at /api/controller/v2. A URL with /api/... in it is used as it is.
    const url = s.url.replace(/\/+$/, "");
    this.#base = /\/api\//.test(`${url}/`) ? url : `${url}/api/v2`;
  }

  async #call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await this.fetcher(`${this.#base}${path}`, {
      ...init,
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${this.s.token}`, ...(init.headers ?? {}) },
    });
    if (r.status === 401) throw new AwxError("AWX refused the token");
    if (r.status === 403) throw new AwxError(`AWX: the token's user may not do that (${path})`);
    if (r.status === 404) throw new AwxError(`AWX has nothing at ${path}`);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new AwxError(`AWX: HTTP ${r.status} for ${path}${text ? `: ${text.slice(0, 500)}` : ""}`);
    }
    return r.status === 204 ? (undefined as T) : ((await r.json()) as T);
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.#call<T>(path, { signal });
  }

  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.#call<T>(path, { method: "POST", body: JSON.stringify(body), signal });
  }

  /** An object's id from its id or its exact name (job templates, inventories). */
  async idOf(kind: "job_templates" | "inventories", ref: string, signal?: AbortSignal): Promise<{ id: number; name: string }> {
    const wanted = ref.trim();
    if (!wanted) throw new AwxError(`which ${kind === "job_templates" ? "job template" : "inventory"}?`);
    if (/^\d+$/.test(wanted)) {
      const one = await this.get<{ id: number; name: string }>(`/${kind}/${wanted}/`, signal);
      return { id: one.id, name: one.name };
    }
    const found = await this.get<{ results: { id: number; name: string }[] }>(`/${kind}/?name=${encodeURIComponent(wanted)}`, signal);
    if (!found.results.length) throw new AwxError(`AWX has no ${kind === "job_templates" ? "job template" : "inventory"} named “${wanted}”`);
    if (found.results.length > 1) throw new AwxError(`AWX has ${found.results.length} named “${wanted}”: give its id`);
    return found.results[0];
  }

  /** Events after `counter`, oldest first (one page; call again for more). */
  async events(jobId: number, after: number, signal?: AbortSignal): Promise<AwxEvent[]> {
    const page = await this.get<{ results: AwxEvent[] }>(`/jobs/${jobId}/job_events/?order_by=counter&counter__gt=${after}&page_size=200`, signal);
    return page.results;
  }
}
