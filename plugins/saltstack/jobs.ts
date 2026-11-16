/**
 * Running one Castor job on a minion: its directory, its variable files (written from the request
 * body, never a command line), the tool's check (and install, if allowed), the command through
 * cmd.run_all (asynchronously, so it can be cancelled), its output, and the files to send back.
 */
import { jobDir, q, type RunResult, type Salt, SaltError, type SaltSettings } from "./salt.ts";

export interface Job {
  id: string;
  command: string;
  runtime: "host" | "container";
  env: Record<string, string>;
  files: { path: string; env: string; mode: number; data: string }[];
  timeoutS: number | null;
  tool: { name: string; image: string | null; check: string; install: string } | null;
  artifacts: string[];
}

export interface IO {
  log(data: string, stream?: "stdout" | "stderr"): void;
  artifact(name: string, content: Uint8Array | string, contentType?: string): Promise<void>;
  signal: AbortSignal;
}

export interface Result {
  exitCode: number | null;
  error?: string;
}

const MAX_ARTIFACT = 20 * 1024 * 1024;

function decode(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function ok(salt: Salt, minion: string, cmd: string, what: string, env?: Record<string, string>): Promise<RunResult> {
  const r = await salt.run(minion, cmd, { env });
  if (r.retcode !== 0) throw new SaltError(`${what} on ${minion}: ${(r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.retcode}`}`);
  return r;
}

export async function runOnMinion(salt: Salt, s: SaltSettings, minion: string, job: Job, io: IO, pollMs = 2000): Promise<Result> {
  if (job.runtime === "container") {
    return { exitCode: null, error: "Salt minions run shell commands here, not containers: give the command a tool with a host install" };
  }
  const dir = jobDir(s.workdir, job.id);
  const env: Record<string, string> = { ...job.env, CASTOR_WORK: dir };
  try {
    await ok(salt, minion, `mkdir -p ${q(dir)} && mkdir -p -m 700 ${q(dir + "/.castor")}`, "making the job's directory");
    for (const f of job.files) {
      const rel = f.path.replace(/^\/+/, "");
      if (!rel.startsWith(".castor/") || rel.split("/").includes("..")) throw new SaltError(`refusing a variable file outside the job: ${f.path}`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.env)) throw new SaltError(`not a variable name: ${f.env}`);
      const path = `${dir}/${rel}`;
      // The value goes in the call's env (the API request's body), never in the command line.
      await ok(salt, minion,
        `umask 077; mkdir -p "$(dirname "$CASTOR_FILE_PATH")" && printf %s "$CASTOR_FILE_DATA" | base64 -d > "$CASTOR_FILE_PATH" && chmod ${(f.mode || 0o600).toString(8)} "$CASTOR_FILE_PATH"`,
        "writing a variable file", { CASTOR_FILE_PATH: path, CASTOR_FILE_DATA: f.data });
      env[f.env] = path;
    }
    if (job.tool) {
      const t = job.tool;
      if (!t.check) {
        return { exitCode: null, error: `${t.name} comes as a container image only, and Salt minions run shell commands here: add a host install to the tool` };
      }
      let found = await salt.run(minion, t.check);
      if (found.retcode !== 0 && s.install_tools && t.install) {
        io.log(`[salt] ${t.name} isn't on ${minion}: installing it\n`, "stderr");
        const installed = await salt.run(minion, t.install);
        io.log(installed.stdout + installed.stderr, "stderr");
        found = await salt.run(minion, t.check);
      }
      if (found.retcode !== 0) {
        return { exitCode: null, error: `${t.name} isn't on ${minion}${t.install ? ` (to install it: ${t.install}; or turn on the plugin's "Install tools")` : ""}` };
      }
    }
    if (io.signal.aborted) return { exitCode: null, error: "cancelled" };
    const jid = await salt.start(minion, job.command, { cwd: dir, env, timeout: job.timeoutS });
    io.log(`[salt] job ${jid} on ${minion} (its output comes when it ends)\n`, "stderr");
    let result: RunResult | null = null;
    while (!result) {
      if (io.signal.aborted) {
        await salt.kill(minion, jid).catch(() => {});
        return { exitCode: null, error: "cancelled" };
      }
      await new Promise((resolve) => {
        const t = setTimeout(resolve, pollMs);
        io.signal.addEventListener("abort", () => (clearTimeout(t), resolve(null)), { once: true });
      });
      result = await salt.result(jid, minion);
    }
    if (result.stdout) io.log(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
    if (result.stderr) io.log(result.stderr.endsWith("\n") ? result.stderr : result.stderr + "\n", "stderr");
    await collect(salt, minion, dir, job.artifacts, io);
    return { exitCode: result.retcode };
  } catch (err) {
    return { exitCode: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await salt.run(minion, `rm -rf ${q(dir + "/.castor")}`).catch(() => {});
  }
}

/** The job's files Castor wants back ("scan.xml", "artifacts/**"), as artifacts. */
export async function collect(salt: Salt, minion: string, dir: string, patterns: string[], io: IO): Promise<void> {
  if (!patterns.length) return;
  const finds = patterns.map((p) =>
    p.endsWith("/**")
      ? `[ -d ${q(p.slice(0, -3))} ] && find ${q(p.slice(0, -3))} -type f`
      : `for f in ${p.split("/").map((part) => (/[*?[]/.test(part) ? part.replace(/[^A-Za-z0-9*?[\]._-]/g, "") : q(part))).join("/")}; do [ -f "$f" ] && [ ! -L "$f" ] && echo "$f"; done`
  );
  const listed = await salt.run(minion, finds.map((f) => `{ ${f}; } 2>/dev/null`).join("; ") + "; true", { cwd: dir });
  const files = [...new Set(listed.stdout.split("\n").map((l) => l.trim().replace(/^\.\//, "")).filter((l) => l && !l.startsWith(".castor/") && !l.split("/").includes("..")))];
  for (const rel of files) {
    const size = Number((await salt.run(minion, `stat -c %s ${q(rel)}`, { cwd: dir })).stdout.trim());
    if (!(size <= MAX_ARTIFACT)) {
      io.log(`[salt] skipped ${rel}: over ${MAX_ARTIFACT / 1024 / 1024} MB\n`, "stderr");
      continue;
    }
    const b64 = await salt.run(minion, `base64 < ${q(rel)}`, { cwd: dir });
    if (b64.retcode !== 0) continue;
    await io.artifact(rel, decode(b64.stdout));
  }
}
