# Mail DNS checks

A pack: library content and no code. It adds to Castor's library, read-only (duplicate an item to
change it), and goes when the plugin is removed:

- **dig**, a tool (Alpine with `bind-tools`, built the first time an agent needs it, or `dig` on a host agent)
- **TXT records**, a parser for what `dig +short TXT` prints
- **Mail servers (MX)**, **SPF record** and **DMARC record**, commands
- **Mail DNS review**, a playbook running all three for one domain

## Working on it

```bash
python3 ../../scripts/pack.py .     # → dist/mail-dns-checks-1.0.0.zip
```
