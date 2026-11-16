/**
 * SaltStack minions as Castor agents (an agent type, docs/PLUGINS.md). Castor asks for the minions
 * that answer the master (grains.items on the target), an admin brings in the ones they want, and
 * each job Castor sends one runs there through salt-api: cmd.run_all, asynchronously so it can be
 * cancelled (saltutil.kill_job). Sandboxed; its only network is the Salt API host set in its settings.
 */
import { definePlugin } from "@castor/plugin";
import { runOnMinion } from "./jobs.ts";
import { Salt, type SaltSettings } from "./salt.ts";

definePlugin({
  activate(ctx) {
    const settings = ctx.settings as unknown as SaltSettings;
    let salt: Salt | null = null;
    const client = () => (salt ??= new Salt(settings));

    ctx.agents.on("minion", {
      list: () => client().minions(),
      run: (job, io) => runOnMinion(client(), settings, io.machine.id, job, io),
    });
  },
});
