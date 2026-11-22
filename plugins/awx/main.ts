/**
 * AWX and Ansible Automation Platform from Castor: launch a job template from a card or a playbook step
 * (library action `launch`), follow its output into the card's console, and bring back what each task
 * did on each host and each host's recap (the same rows as the Ansible plugin's); list an inventory's
 * hosts (library action `inventory`) for Castor to add as SSH hosts. Check runs (the card's "Check run
 * first") and "Retry what failed" go through the template's launch prompts.
 *
 * Sandboxed; its only network is the AWX URL set in its settings.
 */
import { definePlugin } from "@castor/plugin";
import { Awx, AwxError, type AwxEvent, type AwxSettings, hostsOf, inventoryRows, launchBody, type LaunchArgs, type ResultRow, rowOf } from "./awx.ts";

const DONE = new Set(["successful", "failed", "error", "canceled"]);
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((ok) => {
    const t = setTimeout(ok, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), ok()), { once: true });
  });

definePlugin({
  activate(ctx) {
    ctx.actions.on("launch", async (run) => {
      const awx = new Awx(run.settings as unknown as AwxSettings);
      const args = run.args as unknown as LaunchArgs;
      const template = await awx.idOf("job_templates", String(args.template ?? ""), run.signal);
      const prompts = await awx.get<Record<string, unknown>>(`/job_templates/${template.id}/launch/`, run.signal);
      const inventory = args.inventory ? (await awx.idOf("inventories", String(args.inventory), run.signal)).id : undefined;
      const body = launchBody(args, prompts, inventory);
      const launched = await awx.post<{ id?: number; job?: number; ignored_fields?: Record<string, unknown> }>(
        `/job_templates/${template.id}/launch/`, body, run.signal);
      const jobId = Number(launched.job ?? launched.id);
      const ignored = Object.keys(launched.ignored_fields ?? {});
      if (ignored.length) {
        // It started without some of what was asked: stop it rather than run it differently.
        await awx.post(`/jobs/${jobId}/cancel/`, {}).catch(() => {});
        throw new AwxError(`AWX ignored ${ignored.join(", ")} and the job was cancelled`);
      }
      run.log.info(`AWX job ${jobId}: ${template.name}${args.check ? " (check)" : ""}${args.limit ? `, limit ${args.limit}` : ""}`);

      const results: ResultRow[] = [];
      let stats: Record<string, unknown> = {};
      let counter = 0;
      let status = "pending";
      const pause = Math.max(1, Number((run.settings as Record<string, unknown>).poll_seconds ?? 2)) * 1000;
      const take = (events: AwxEvent[]) => {
        for (const ev of events) {
          counter = Math.max(counter, ev.counter);
          if (ev.stdout) run.log.info(ev.stdout);
          const row = rowOf(ev);
          if (row) results.push(row);
          if (ev.event === "playbook_on_stats") stats = (ev.event_data ?? {}) as Record<string, unknown>;
        }
        return events.length;
      };
      while (!DONE.has(status)) {
        if (run.signal.aborted) {
          await awx.post(`/jobs/${jobId}/cancel/`, {}).catch(() => {});
          return { message: `Cancelled AWX job ${jobId}` };
        }
        const job = await awx.get<{ status: string }>(`/jobs/${jobId}/`, run.signal).catch((e) => {
          if (run.signal.aborted) return { status };
          throw e;
        });
        status = job.status;
        while (take(await awx.events(jobId, counter)) === 200);
        run.progress({ text: `${status} · ${results.length} task result${results.length === 1 ? "" : "s"}` });
        if (!DONE.has(status)) await sleep(pause, run.signal);
      }
      while (take(await awx.events(jobId, counter)) === 200); // the last events land just after the status
      const hosts = hostsOf(stats);
      const output = { awx_job: jobId, status, results, hosts };
      const said = `AWX job ${jobId} ${status}: ${hosts.length} host${hosts.length === 1 ? "" : "s"}`;
      if (status !== "successful") return { message: said, output, error: `AWX job ${jobId} ${status}` };
      return { message: said, output };
    });

    ctx.actions.on("inventory", async (run) => {
      const awx = new Awx(run.settings as unknown as AwxSettings);
      const inv = await awx.idOf("inventories", String(run.args.inventory ?? ""), run.signal);
      const script = await awx.get<Record<string, unknown>>(`/inventories/${inv.id}/script/?hostvars=1&towervars=1`, run.signal);
      const rows = inventoryRows(script);
      return { message: `${inv.name}: ${rows.length} host${rows.length === 1 ? "" : "s"}`, output: rows };
    });
  },
});
