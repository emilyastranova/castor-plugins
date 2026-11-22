import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { Awx, AwxError, hostsOf, inventoryRows, launchBody, rowOf } from "./awx.ts";

const ALL_PROMPTS = {
  ask_inventory_on_launch: true, ask_limit_on_launch: true, ask_variables_on_launch: true, ask_tags_on_launch: true,
  ask_skip_tags_on_launch: true, ask_job_type_on_launch: true, ask_diff_mode_on_launch: true,
};

Deno.test("a launch asks only for what the template prompts for", () => {
  assertEquals(launchBody({ template: "t", limit: "web1,db1", check: true, diff: true, extra_vars: "a: 1" }, ALL_PROMPTS, 7), {
    inventory: 7, limit: "web1,db1", extra_vars: "a: 1", job_type: "check", diff_mode: true,
  });
  assertEquals(launchBody({ template: "t", check: false, limit: "" }, {}), {});
  // A check run the template would run for real, a limit it would drop: refused before launching.
  const e = assertThrows(() => launchBody({ template: "t", check: true, limit: "web1" }, { ask_limit_on_launch: true }), AwxError);
  assertEquals(e.message.includes("Job type") && !e.message.includes("Limit"), true);
});

Deno.test("job events become results rows, the stats a recap per host", () => {
  assertEquals(rowOf({ counter: 1, event: "playbook_on_task_start" }), null);
  assertEquals(rowOf({
    counter: 5, event: "runner_on_ok", host_name: "web1",
    event_data: { play: "site", task: "copy motd", task_action: "copy", duration: 0.51234, res: { changed: true, msg: "" } },
  }), { host: "web1", play: "site", task: "copy motd", action: "copy", status: "changed", changed: true, msg: "", rc: null, duration: 0.512 });
  assertEquals(rowOf({ counter: 6, event: "runner_on_failed", host_name: "web2", event_data: { ignore_errors: true, res: { rc: 2, stderr: "nope" } } })?.status, "ignored");
  assertEquals(rowOf({ counter: 7, event: "runner_on_unreachable", host_name: "db1", event_data: { res: { msg: { reason: "timeout" } } } })?.msg, '{"reason":"timeout"}');
  assertEquals(hostsOf({ ok: { web1: 3, web2: 1 }, changed: { web1: 1 }, failures: { web2: 1 }, dark: { db1: 1 } }).map((h) => [h.host, h.status]), [
    ["db1", "unreachable"], ["web1", "changed"], ["web2", "failed"],
  ]);
});

Deno.test("an inventory script becomes rows Castor adds as SSH hosts", () => {
  const rows = inventoryRows({
    _meta: { hostvars: { w1: { ansible_host: "10.0.0.1", ansible_port: 2222, ansible_user: "deploy" }, win: { ansible_connection: "winrm" } } },
    all: { children: ["prod"] },
    prod: { children: ["web"] },
    web: { hosts: ["w1", "win"] },
  });
  assertEquals(rows[0], { name: "w1", host: "10.0.0.1", port: 2222, user: "deploy", groups: ["prod", "web"], skip: null });
  assertEquals(String(rows[1].skip).includes("winrm"), true);
});

Deno.test("the client: names to ids, tokens, AAP's path", async () => {
  const seen: string[] = [];
  const fake = (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${url} ${(init?.headers as Record<string, string>)?.Authorization}`);
    if (url.endsWith("/job_templates/?name=Deploy%20web")) return Promise.resolve(Response.json({ results: [{ id: 12, name: "Deploy web" }] }));
    if (url.endsWith("/job_templates/?name=Nope")) return Promise.resolve(Response.json({ results: [] }));
    if (url.endsWith("/job_templates/9/")) return Promise.resolve(Response.json({ id: 9, name: "Nine" }));
    return Promise.resolve(new Response("", { status: 401 }));
  };
  const awx = new Awx({ url: "https://awx.example.com/", token: "tok" }, fake);
  assertEquals(await awx.idOf("job_templates", "Deploy web"), { id: 12, name: "Deploy web" });
  assertEquals(await awx.idOf("job_templates", "9"), { id: 9, name: "Nine" });
  assertEquals(seen[0], "GET https://awx.example.com/api/v2/job_templates/?name=Deploy%20web Bearer tok");
  await assertRejects(() => awx.idOf("job_templates", "Nope"), AwxError, "no job template named");
  await assertRejects(() => awx.get("/me/"), AwxError, "refused the token");
  const aap = new Awx({ url: "https://aap.example.com/api/controller/v2", token: "t" }, (u) => (seen.push(u), Promise.resolve(Response.json({ id: 1, name: "x" }))));
  await aap.idOf("inventories", "1");
  assertEquals(seen.at(-1), "https://aap.example.com/api/controller/v2/inventories/1/");
});
