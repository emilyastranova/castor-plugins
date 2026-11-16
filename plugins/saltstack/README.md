# SaltStack minions

Run Castor's command cards and playbook steps on **Salt minions**, through the Salt master's REST
API (salt-api, `rest_cherrypy`). Each minion you add is a Castor agent: cards pick it by name or
tag, project limits apply, and its output, results and artifacts come back like any agent's.

- **Machines:** the minions of the target (default `*`) that answer `grains.items`. Agents →
  **Add from a plugin** → **Salt minion** lists them; tick the ones to add.
- **Tags** come from grains (`os:Ubuntu`, `roles:web`…, the grains are a setting) and are kept up to
  date every 10 minutes; tags you add yourself stay.
- **Jobs** run as `cmd.run_all` in their own directory (`CASTOR_WORK`, under the job directory
  setting), started asynchronously so **cancel** works (`saltutil.kill_job`). Salt doesn't stream
  output: it comes when the job ends.
- **Variables** reach the minion in the API call's `env` (and variable files are written from it),
  never in a command line, and are removed afterwards. Castor masks secrets in the output.
- **Tools:** a command's tool is checked on the minion with its host check; with **Install tools**
  on, a missing one is installed with the tool's install command. Container-only tools can't run
  here (minions run shell commands).
- **Artifacts:** the files a command declares, and anything under `artifacts/`, are sent back
  (up to 20 MB each).

**Runs sandboxed.** It asks Castor for nothing; its only network is the Salt API host you set.

## Set up

1. salt-api on the master, with a certificate this Castor server trusts, and an external-auth user
   allowed `cmd.run_all`, `grains.items` and `saltutil.kill_job` on the minions (and `@jobs` for
   `/jobs`), e.g. in the master config:

   ```yaml
   external_auth:
     pam:
       castor:
         - 'web*':
           - cmd.run_all
           - grains.items
           - saltutil.kill_job
         - '@jobs'
   ```

2. Install the plugin (Settings → Plugins), set the **Salt API URL**, **Username** and
   **Password**, and turn it on.
3. Agents → **Add from a plugin** → **Salt minion**: pick minions, tags and projects.

## Work on it

```bash
cd plugins/saltstack
deno task check
deno task test     # against a fake salt-api
```
