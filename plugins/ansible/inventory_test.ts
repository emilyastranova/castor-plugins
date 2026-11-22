// deno test   (pure: no Castor)
import { buildInventory, groupName } from "./inventory.ts";

function assertEquals(a: unknown, b: unknown, why = "") {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${why}\n  got ${JSON.stringify(a)}\n  not ${JSON.stringify(b)}`);
}

const hosts = [
  { id: "h1", fields: { ip: "10.0.0.5", hostname: "web01.lab", os: "Ubuntu 24.04", roles: ["web", "DMZ server"] } },
  { id: "h2", fields: { ip: "10.0.0.9" } },
];
const services = [
  { fields: { host: "10.0.0.5", port: 443, name: "https" } },
  { fields: { host: "web01.lab", port: 22, name: "ssh" } },
];

Deno.test("hosts by name, the address as ansible_host, roles as groups, services as variables", () => {
  const inv = buildInventory(hosts, services);
  assertEquals(Object.keys(inv.all.hosts), ["web01.lab", "10.0.0.9"]);
  const web = inv.all.hosts["web01.lab"];
  assertEquals(web.ansible_host, "10.0.0.5");
  assertEquals(web.castor_os, "Ubuntu 24.04");
  assertEquals(web.castor_ports, [22, 443]);
  assertEquals(inv.all.hosts["10.0.0.9"], { castor_asset_id: "h2" }, "an address-only host needs no ansible_host");
  assertEquals(Object.keys(inv.all.children).sort(), ["dmz_server", "web"]);
});

Deno.test("targets: the ones given, matched to assets where Castor knows them", () => {
  const inv = buildInventory(hosts, services, ["10.0.0.5", "new.example"]);
  assertEquals(Object.keys(inv.all.hosts), ["10.0.0.5", "new.example"]);
  assertEquals(inv.all.hosts["10.0.0.5"].castor_asset_id, "h1");
  assertEquals(inv.all.hosts["new.example"], {});
});

Deno.test("group names Ansible accepts", () => {
  assertEquals(groupName("Domain Controllers"), "domain_controllers");
  assertEquals(groupName("2024-hosts"), "g_2024_hosts");
  assertEquals(groupName("---"), "");
});
