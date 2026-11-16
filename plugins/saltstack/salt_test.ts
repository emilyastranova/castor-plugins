// deno test   (a fake salt-api; no network)
import { type IO, type Job, runOnMinion } from "./jobs.ts";
import { machineOf, Salt } from "./salt.ts";

function assert(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error(why);
}

interface Low {
  client: string;
  tgt?: string;
  fun: string;
  arg?: string[];
  kwarg?: Record<string, unknown>;
}

/** A pretend salt-api: logins, grains, async jobs that finish on the second poll, kill_job. */
function fakeApi() {
  const calls: Low[] = [];
  const files = new Map<string, string>();
  let logins = 0;
  const jobs = new Map<string, { polls: number; low: Low }>();
  const fetcher = (url: string, init?: RequestInit): Promise<Response> => {
    const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (url.endsWith("/login")) {
      logins++;
      const b = JSON.parse(String(init?.body));
      return b.password === "pw" ? json({ return: [{ token: `t${logins}` }] }) : json({}, 401);
    }
    const m = url.match(/\/jobs\/(\d+)$/);
    if (m) {
      const j = jobs.get(m[1])!;
      j.polls++;
      if (j.polls < 2) return json({ info: [{ Result: {} }], return: [{}] });
      const cmd = String(j.low.arg?.[0]);
      const env = (j.low.kwarg?.env ?? {}) as Record<string, string>;
      return json({ info: [{ Result: { web01: { return: { retcode: cmd.includes("fail") ? 2 : 0, stdout: `ran ${cmd} with ${env.GREETING}`, stderr: "" } } } }] });
    }
    const low = JSON.parse(String(init?.body))[0] as Low;
    calls.push(low);
    if (low.fun === "grains.items") {
      return json({ return: [{ web01: { fqdn: "web01.lab", os: "Ubuntu", osfinger: "Ubuntu-24.04", roles: ["web", "nginx"], osmajorrelease: 24 }, db01: false }] });
    }
    if (low.client === "local_async") {
      const jid = String(20261124000000 + jobs.size);
      jobs.set(jid, { polls: 0, low });
      return json({ return: [{ jid, minions: ["web01"] }] });
    }
    if (low.fun === "saltutil.kill_job") return json({ return: [{ web01: {} }] });
    // cmd.run_all, synchronously: the helpers (mkdir, files, tool checks, collecting).
    const cmd = String(low.arg?.[0]);
    const env = (low.kwarg?.env ?? {}) as Record<string, string>;
    if (env.CASTOR_FILE_PATH) files.set(env.CASTOR_FILE_PATH, atob(env.CASTOR_FILE_DATA));
    let out = { retcode: 0, stdout: "", stderr: "" };
    if (cmd === "nmap --version") out = { retcode: 127, stdout: "", stderr: "not found" };
    else if (cmd.includes("find 'artifacts'")) out = { retcode: 0, stdout: "artifacts/report.txt\n", stderr: "" };
    else if (cmd.startsWith("stat")) out = { retcode: 0, stdout: "5\n", stderr: "" };
    else if (cmd.startsWith("base64")) out = { retcode: 0, stdout: btoa("hello"), stderr: "" };
    return json({ return: [{ web01: out }] });
  };
  return { fetcher, calls, files, jobs };
}

function io(abortAfter?: number) {
  const lines: [string, string][] = [];
  const artifacts: Record<string, string> = {};
  const abort = new AbortController();
  if (abortAfter !== undefined) setTimeout(() => abort.abort(), abortAfter);
  const it: IO = {
    log: (data, stream = "stdout") => void lines.push([stream, data]),
    artifact: (name, content) => Promise.resolve(void (artifacts[name] = typeof content === "string" ? content : new TextDecoder().decode(content))),
    signal: abort.signal,
  };
  return { it, lines, artifacts };
}

const SETTINGS = { api_url: "https://salt.lab:8000/", username: "castor", password: "pw", workdir: "/var/tmp/castor" };

function job(over: Partial<Job> = {}): Job {
  return { id: "0b8c2f1e-1111-4a4a-9e9e-123456789abc", command: "uptime", runtime: "host", env: { GREETING: "hi" }, files: [], timeoutS: null, tool: null,
    artifacts: [], ...over };
}

Deno.test("minions become machines tagged from their grains", async () => {
  const api = fakeApi();
  const salt = new Salt({ ...SETTINGS, tag_grains: "os, roles" }, api.fetcher);
  const minions = await salt.minions();
  assert(minions.length === 1 && minions[0].id === "web01", "only the minions that answered");
  assert(JSON.stringify(minions[0].tags) === JSON.stringify(["os:Ubuntu", "roles:nginx", "roles:web"]), JSON.stringify(minions[0].tags));
  assert(minions[0].hostname === "web01.lab" && minions[0].os === "Ubuntu-24.04", "hostname and OS");
  assert(machineOf("x", {}, ["os"]).tags.length === 0, "no grains, no tags");
});

Deno.test("a job runs with its variables in env, its files written, its artifacts sent back", async () => {
  const api = fakeApi();
  const salt = new Salt(SETTINGS, api.fetcher);
  const { it, lines, artifacts } = io();
  const secret = "s3cr3t";
  const res = await runOnMinion(salt, SETTINGS, "web01", job({
    command: "echo $GREETING", files: [{ path: ".castor/creds/key", env: "CASTOR_VAR_KEY", mode: 0o600, data: btoa(secret) }],
    artifacts: ["artifacts/**"],
  }), it, 1);
  assert(res.exitCode === 0 && !res.error, JSON.stringify(res));
  const started = api.calls.find((c) => c.client === "local_async")!;
  assert(started.kwarg?.cwd === "/var/tmp/castor/0b8c2f1e-1111-4a4a-9e9e-123456789abc", "its own directory");
  const env = started.kwarg?.env as Record<string, string>;
  assert(env.GREETING === "hi" && env.CASTOR_VAR_KEY.endsWith("/.castor/creds/key") && env.CASTOR_WORK.endsWith("123456789abc"), "env");
  assert(!api.calls.some((c) => String(c.arg?.[0]).includes(secret) || String(c.arg?.[0]).includes(btoa(secret))), "no secret in a command line");
  assert(api.files.get(env.CASTOR_VAR_KEY) === secret, "the variable file written from env");
  assert(lines.some(([s, d]) => s === "stdout" && d.includes("ran echo $GREETING with hi")), JSON.stringify(lines));
  assert(artifacts["artifacts/report.txt"] === "hello", JSON.stringify(artifacts));
  assert(api.calls.at(-1)!.arg?.[0].startsWith("rm -rf "), "the variable files removed afterwards");
});

Deno.test("exit codes, missing tools and containers", async () => {
  const api = fakeApi();
  const salt = new Salt(SETTINGS, api.fetcher);
  assert((await runOnMinion(salt, SETTINGS, "web01", job({ command: "fail now" }), io().it, 1)).exitCode === 2, "the minion's exit code");
  const tool = { name: "nmap", image: "docker.io/instrumentisto/nmap", check: "nmap --version", install: "apt-get install -y nmap" };
  const missing = await runOnMinion(salt, SETTINGS, "web01", job({ tool }), io().it, 1);
  assert(missing.exitCode === null && missing.error!.includes("apt-get install -y nmap"), JSON.stringify(missing));
  const imageOnly = await runOnMinion(salt, SETTINGS, "web01", job({ tool: { ...tool, check: "", install: "" } }), io().it, 1);
  assert(imageOnly.error!.includes("container image only"), imageOnly.error!);
  const container = await runOnMinion(salt, SETTINGS, "web01", job({ runtime: "container" }), io().it, 1);
  assert(container.error!.includes("not containers"), container.error!);
});

Deno.test("cancelling kills the Salt job", async () => {
  const api = fakeApi();
  const salt = new Salt(SETTINGS, api.fetcher);
  const res = await runOnMinion(salt, SETTINGS, "web01", job({ command: "sleep 600" }), io(5).it, 1000);
  assert(res.error === "cancelled", JSON.stringify(res));
  assert(api.calls.some((c) => c.fun === "saltutil.kill_job"), "saltutil.kill_job");
});

Deno.test("a wrong password says so", async () => {
  const salt = new Salt({ ...SETTINGS, password: "nope" }, fakeApi().fetcher);
  let said = "";
  await salt.minions().catch((e) => (said = String(e.message)));
  assert(said.includes("refused"), said);
});
