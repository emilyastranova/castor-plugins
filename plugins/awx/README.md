# AWX and Ansible Automation Platform

Launch **AWX / Ansible Automation Platform job templates** from Castor's cards and playbook steps, for
teams that already run Ansible there: the job's output follows into the card's console, and what each
task did on each host comes back as results.

- **AWX job template** (a Library action, `awx-launch`): the template by name or id, and what its
  launch prompts allow: inventory, limit, extra vars, tags, skip tags, check mode and diff. An argument
  the template doesn't prompt for is refused before anything is launched (AWX would otherwise ignore
  it: a check run would run for real), and a job AWX started without something it was asked for is
  cancelled.
- **Results:** per task and host (`results`: ok, changed, failed, unreachable, skipped, ignored, with
  the message and return code) and each host's recap (`hosts`), the same rows as the Ansible plugin's,
  so runs compare like any card's. An AWX job that fails fails the card, with its results kept.
- **Check run first:** turn **Check run first** on for a card (or `preview: true` on a playbook step):
  each run starts as a Check job with diffs, and a person approves the real run after looking at it.
- **Retry what failed:** only the failed and unreachable hosts, as the limit (a card's Output, or a
  playbook step's `retry_failed`).
- **AWX inventory** (`awx-inventory`): an inventory's hosts, with how to reach each and its groups; the
  run's Output offers to add them as Castor's SSH hosts (admins).
- **Cancel** cancels the AWX job.

**Runs sandboxed.** It asks Castor for nothing; its only network is the AWX URL you set.

## Set up

1. In AWX, a user that may launch the job templates and read their jobs and inventories, and an OAuth2
   token for it (Users → the user → Tokens, scope Write). For check runs and retries, turn **Prompt on
   launch** on for the template's Job type, Limit and Show changes.
2. Settings → Plugins → install **AWX and Ansible Automation Platform**: the URL (`https://awx.example.com`;
   AAP 2.5's gateway: `https://aap.example.com/api/controller/v2`), and the token, one for everyone or
   each person's own (so AWX shows who launched what). Castor needs to trust the certificate.
3. Enable it in the projects that use it; the actions are in the Library's plugin folder.

Needs Castor 1.16.1 or later.
