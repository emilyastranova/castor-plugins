/**
 * Talking to salt-api (rest_cherrypy) and turning its answers into Castor's terms. No Castor SDK
 * here, so it's tested on its own (salt_test.ts) with a fake API.
 */

export interface SaltSettings {
  api_url: string;
  username: string;
  password: string;
  eauth?: string;
  target?: string;
  workdir?: string;
  tag_grains?: string;
  install_tools?: boolean;
}

export type Grains = Record<string, unknown>;

export interface MinionMachine {
  id: string;
  name: string;
  hostname: string;
  os: string;
  tags: string[];
  facts: Record<string, string | number | boolean>;
}

export interface RunResult {
  retcode: number;
  stdout: string;
  stderr: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class SaltError extends Error {}

/** A minion's grains as a Castor machine: tags from the chosen grains ("os:Ubuntu", one per list item). */
export function machineOf(id: string, grains: Grains, tagGrains: string[]): MinionMachine {
  const tags: string[] = [];
  for (const g of tagGrains) {
    const v = grains[g];
    for (const item of Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") tags.push(`${g}:${item}`);
    }
  }
  const facts: Record<string, string | number | boolean> = {};
  for (const k of ["os", "osfinger", "osrelease", "kernel", "cpuarch", "fqdn", "virtual", "saltversion"]) {
    const v = grains[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") facts[k] = v;
  }
  const os = String(grains.osfinger ?? [grains.os, grains.osrelease].filter(Boolean).join(" "));
  return { id, name: id, hostname: String(grains.fqdn ?? grains.host ?? id), os, tags: [...new Set(tags)].sort(), facts };
}

/** sh-quote one word. */
export function q(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

/** A job's directory on the minion: its own, under the workdir. */
export function jobDir(workdir: string | undefined, jobId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(jobId)) throw new SaltError(`not a job id: ${jobId}`);
  return `${(workdir || "/var/tmp/castor").replace(/\/+$/, "")}/${jobId}`;
}

export class Salt {
  #token: string | null = null;
  #base: string;

  constructor(private s: SaltSettings, private fetcher: Fetch = fetch) {
    if (!s.api_url) throw new SaltError("No Salt API URL: set it in the plugin's settings");
    this.#base = s.api_url.replace(/\/+$/, "");
  }

  async #login(): Promise<string> {
    const r = await this.fetcher(`${this.#base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: this.s.username, password: this.s.password, eauth: this.s.eauth || "pam" }),
    });
    if (r.status === 401 || r.status === 403) throw new SaltError("salt-api refused the username or password");
    if (!r.ok) throw new SaltError(`salt-api login: HTTP ${r.status}`);
    const token = (await r.json())?.return?.[0]?.token;
    if (!token) throw new SaltError("salt-api login gave no token");
    return (this.#token = String(token));
  }

  /** One lowstate call (a list of one), logging in again once if the token expired. */
  async call(low: Record<string, unknown>, again = true): Promise<unknown> {
    const token = this.#token ?? (await this.#login());
    const r = await this.fetcher(`${this.#base}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Auth-Token": token },
      body: JSON.stringify([low]),
    });
    if (r.status === 401 && again) {
      this.#token = null;
      return this.call(low, false);
    }
    if (!r.ok) throw new SaltError(`salt-api: HTTP ${r.status} for ${low.fun}`);
    return (await r.json())?.return?.[0];
  }

  async get(path: string, again = true): Promise<unknown> {
    const token = this.#token ?? (await this.#login());
    const r = await this.fetcher(`${this.#base}${path}`, { headers: { Accept: "application/json", "X-Auth-Token": token } });
    if (r.status === 401 && again) {
      this.#token = null;
      return this.get(path, false);
    }
    if (!r.ok) throw new SaltError(`salt-api: HTTP ${r.status} for ${path}`);
    return await r.json();
  }

  /** The minions of the target that answer now, as machines. */
  async minions(): Promise<MinionMachine[]> {
    const out = (await this.call({ client: "local", tgt: this.s.target || "*", fun: "grains.items", timeout: 30 })) as Record<string, Grains | boolean>;
    const tagGrains = String(this.s.tag_grains ?? "os,osmajorrelease,roles,environment,virtual").split(",").map((g) => g.trim()).filter(Boolean);
    return Object.entries(out ?? {})
      .filter(([, g]) => g && typeof g === "object")
      .map(([id, g]) => machineOf(id, g as Grains, tagGrains))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Start cmd.run_all on one minion (asynchronously): its job id. */
  async start(minion: string, cmd: string, opts: { cwd?: string; env?: Record<string, string>; timeout?: number | null } = {}): Promise<string> {
    const kwarg: Record<string, unknown> = { python_shell: true, shell: "/bin/sh" };
    if (opts.cwd) kwarg.cwd = opts.cwd;
    if (opts.env && Object.keys(opts.env).length) kwarg.env = opts.env; // in the request body, never in the command line
    if (opts.timeout) kwarg.timeout = opts.timeout;
    const out = (await this.call({ client: "local_async", tgt: minion, tgt_type: "list", fun: "cmd.run_all", arg: [cmd], kwarg })) as
      | { jid?: string; minions?: string[] }
      | undefined;
    if (!out?.jid) throw new SaltError(`the Salt master didn't start a job on ${minion} (is it answering?)`);
    if (out.minions && !out.minions.includes(minion)) throw new SaltError(`${minion} isn't answering the Salt master`);
    return String(out.jid);
  }

  /** A job's result on the minion, or null while it runs. */
  async result(jid: string, minion: string): Promise<RunResult | null> {
    const body = (await this.get(`/jobs/${encodeURIComponent(jid)}`)) as { info?: { Result?: Record<string, { return?: unknown }> }[]; return?: Record<string, unknown>[] };
    const fromInfo = body?.info?.[0]?.Result?.[minion]?.return;
    const ret = fromInfo ?? body?.return?.[0]?.[minion];
    if (ret === undefined || ret === null) return null;
    if (typeof ret === "object" && "retcode" in (ret as Record<string, unknown>)) {
      const r = ret as Record<string, unknown>;
      return { retcode: Number(r.retcode ?? 1), stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
    }
    // An error Salt returns as text ("'cmd.run_all' is not available", a module's exception).
    return { retcode: 1, stdout: "", stderr: typeof ret === "string" ? ret : JSON.stringify(ret) };
  }

  /** Run and wait (short helper commands: setting up, collecting files). */
  async run(minion: string, cmd: string, opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
    const out = (await this.call({ client: "local", tgt: minion, tgt_type: "list", fun: "cmd.run_all", arg: [cmd],
      kwarg: { python_shell: true, shell: "/bin/sh", ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.env ? { env: opts.env } : {}) } })) as Record<string, unknown>;
    const r = out?.[minion] as Record<string, unknown> | string | undefined;
    if (r === undefined) throw new SaltError(`${minion} didn't answer`);
    if (typeof r !== "object") return { retcode: 1, stdout: "", stderr: String(r) };
    return { retcode: Number(r.retcode ?? 1), stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  }

  async kill(minion: string, jid: string): Promise<void> {
    await this.call({ client: "local", tgt: minion, tgt_type: "list", fun: "saltutil.kill_job", arg: [jid] });
  }
}
