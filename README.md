# Castor plugins

The plugin directory for [Castor](https://github.com/emilyastranova/castor), and Castor's own
plugins.

- **`directory.json`** lists publishers and their plugins. Castor reads it (Settings → Plugins →
  Browse), finds each plugin's newest GitHub release, and checks the download against its
  published SHA-256 before showing what the plugin asks for. Nothing here is reviewed: the install
  review in Castor, and the sandbox plugins run in, are what keep an instance safe.
- **`plugins/`** holds the official plugins. Each is released from this repository with the tag
  `<id>-v<version>`.

| Plugin | What it does |
| --- | --- |
| [Nessus import](plugins/nessus-import) | A .nessus scan becomes hosts, services and vulnerabilities |
| [Shodan enrichment](plugins/shodan-enrich) | New external hosts get their ports, banners and CVEs from Shodan |
| [BloodHound bridge](plugins/bloodhound) | A SharpHound collection becomes users, computers, domains and attack paths |
| [DOCX report](plugins/docx-report) | A project's findings as a Word document |
| [Watch folder](plugins/folder-watch) | Imports scan files dropped into a folder on the server (unrestricted) |
| [Source Code Review](plugins/source-code-review) | Repositories, files and symbols as assets, with their imports and calls |
| [Mail DNS checks](plugins/mail-dns-checks) | A pack: MX, SPF and DMARC commands and a playbook, no code |

## Writing a plugin

The format is in Castor's [docs/PLUGINS.md](https://github.com/emilyastranova/castor/blob/main/docs/PLUGINS.md)
and the wiki's [Plugins](https://github.com/emilyastranova/castor/wiki/Plugins) page. Pack one into
the `.zip` Castor installs:

```bash
python3 scripts/pack.py plugins/nessus-import       # → dist/nessus-import-1.0.0.zip
```

Plugins' Deno tests import the SDK from Castor's repository on GitHub (each `deno.json`). To work
against a local Castor checkout, override it: `deno test --import-map=<map>`.

## Checks

```bash
pip install -e ../castor/server                       # Castor's own checks (one virtualenv)
python3 scripts/check_directory.py                    # directory.json and every plugin here
python3 scripts/check_directory.py --releases         # also each plugin's newest release
CASTOR_PLUGINS_REPO=$PWD python -m pytest ../castor/server/tests/test_plugins.py   # run them in a real Castor
```

CI runs all of these on every pull request. Merging a change to a plugin whose `version:` has no
release yet releases it (`scripts/release.py`).

## Adding your plugin to the directory

See [CONTRIBUTING.md](CONTRIBUTING.md).
