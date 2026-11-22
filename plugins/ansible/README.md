# Ansible playbooks

Run **Ansible playbooks** from Castor, on your agents, against the project's hosts: like any command
card, with what each task did on each host as results on the card, and the facts the hosts report as
the project's hosts.

- **Commands** in the Library's Ansible folder: **Ansible playbook from Git** (a repository, a
  branch or tag, the playbook's path; its `requirements.yml` installs roles and collections),
  **Ansible playbook (written here)** for one-offs, and **Ansible inventory** (below). Both are cards and playbook steps like any command.
- **Inventory from Castor:** as the job is sent, the plugin builds it from the project's hosts: the
  card's **targets**, or every host matching **asset filter** (as on the Assets page: `os:ubuntu`,
  `roles:web`) in **scope** (a scope group, `*` for any). Each host is named by its hostname (else its
  address) with `ansible_host`, grouped by its roles, and carries what Castor knows of it as host
  variables: `castor_os`, `castor_domain`, `castor_ports`, `castor_services`… A repository's own
  inventory can be used instead (**inventory path**). The card's Output shows the inventory a run got.
- **Credentials from the vault**, never in a command line: an **SSH key** variable set (the key and
  user it connects with, and clones `git@` repositories with), a **credential** for the become
  password (written to an owner-only file for `--become-password-file`, removed afterwards), an
  **Ansible Vault password** set (a new variable kind: the file for `--vault-password-file`) and an
  **API token** for a private HTTPS repository.
- **Arguments:** extra vars (YAML or JSON), limit, tags and skip tags, check mode and diff, and
  whether unknown SSH host keys are refused.
- **Results:** a callback the plugin puts in the job writes what each task did on each host
  (`ansible-results`: host, task, ok/changed/failed/unreachable/skipped, message) and each host's recap
  and facts (`ansible-hosts`), next to Ansible's usual output in the console. Runs compare like any
  card's. The reachable hosts' facts (address, name, OS, domain, MAC, gateway, DNS servers) become the
  project's hosts.

- **Check run first:** turn **Check run first** on for a card (or `preview: true` on a playbook step)
  and each run starts with `--check --diff`; a person looks at what it would change, then approves
  the real run.
- **Retry what failed:** a run where some hosts failed or couldn't be reached offers to run again on
  only those (as the limit). A playbook step does it by itself with `retry_failed: 1` (up to 5).
- **Inventories as SSH hosts:** the **Ansible inventory** command lists the hosts of an inventory in a
  repository, static or dynamic (`aws_ec2`, `netbox`… with the collections its `requirements.yml`
  installs); the run's Output offers to add them as Castor's SSH hosts, with one key for them all and
  their groups as tags (admins). A pasted inventory works too: Agents → From an inventory.

Runs on an agent with a container runtime: the **ansible** tool is an image recipe (Python's slim
image with `ansible-core` 2.18, git and OpenSSH), built once per agent. The agent has to reach the
hosts, so pick it (or a network route) as for any command.

**Runs sandboxed.** It reads the project's hosts and services (`assets:read`) to build inventories.
It has no network of its own; Ansible runs on the agent.

Needs Castor 1.16.1 or later (plugin hooks, previews and retries).
