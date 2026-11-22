/**
 * The inventory Castor's assets make (pure, tested in inventory_test.ts): one host per asset, named
 * by its hostname (else its address), `ansible_host` its address, groups from its roles, and what
 * Castor knows of it as `castor_*` host variables (OS, domain, open services).
 */

export interface HostAsset {
  id: string;
  label?: string;
  fields: Record<string, unknown>;
}

export interface ServiceAsset {
  fields: Record<string, unknown>;
}

export interface Inventory {
  all: { hosts: Record<string, Record<string, unknown>>; children: Record<string, { hosts: Record<string, null> }> };
}

const GROUP = /[^a-z0-9_]+/g;

/** A group name Ansible accepts: lowercase letters, digits and underscores, not starting with a digit. */
export function groupName(raw: string): string {
  const name = raw.toLowerCase().replace(GROUP, "_").replace(/^_+|_+$/g, "");
  return !name ? "" : /^\d/.test(name) ? `g_${name}` : name;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/** Build it from hosts (and the project's services, to list each host's). `targets`, when given, are
 *  the hosts to use (matched to assets by address or name; ones Castor doesn't know are used as written). */
export function buildInventory(hosts: HostAsset[], services: ServiceAsset[], targets: string[] = []): Inventory {
  const byKey = new Map<string, HostAsset>();
  for (const h of hosts) {
    for (const key of [text(h.fields.ip), text(h.fields.hostname)].filter(Boolean)) byKey.set(key.toLowerCase(), h);
  }
  const chosen: { name: string; asset?: HostAsset; address?: string }[] = [];
  if (targets.length) {
    for (const t of targets.map(text).filter(Boolean)) chosen.push({ name: t, asset: byKey.get(t.toLowerCase()) });
  } else {
    for (const h of hosts) {
      const ip = text(h.fields.ip);
      const name = text(h.fields.hostname) || ip;
      if (name) chosen.push({ name, asset: h, address: ip || undefined });
    }
  }
  const servicesOf = new Map<string, Record<string, unknown>[]>();
  for (const s of services) {
    const host = text(s.fields.host).toLowerCase();
    if (!host) continue;
    const list = servicesOf.get(host) ?? [];
    list.push({ port: s.fields.port ?? null, proto: s.fields.proto ?? "tcp", name: s.fields.name ?? null, product: s.fields.product ?? null });
    servicesOf.set(host, list);
  }
  const inv: Inventory = { all: { hosts: {}, children: {} } };
  const seen = new Set<string>();
  for (const c of chosen) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    const f = c.asset?.fields ?? {};
    const vars: Record<string, unknown> = {};
    const address = c.address ?? text(f.ip);
    if (address && address !== c.name) vars.ansible_host = address;
    if (c.asset) {
      vars.castor_asset_id = c.asset.id;
      for (const key of ["os", "domain", "status", "mac", "gateway"]) if (text(f[key])) vars[`castor_${key}`] = f[key];
      const mine = [...(servicesOf.get(text(f.ip).toLowerCase()) ?? []), ...(servicesOf.get(text(f.hostname).toLowerCase()) ?? [])];
      if (mine.length) {
        vars.castor_services = mine;
        vars.castor_ports = [...new Set(mine.map((s) => Number(s.port)).filter((p) => Number.isFinite(p)))].sort((a, b) => a - b);
      }
      for (const role of Array.isArray(f.roles) ? f.roles : []) {
        const group = groupName(String(role));
        if (group && group !== "all" && group !== "ungrouped") (inv.all.children[group] ??= { hosts: {} }).hosts[c.name] = null;
      }
    }
    inv.all.hosts[c.name] = vars;
  }
  return inv;
}
