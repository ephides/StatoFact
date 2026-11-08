import "server-only";
import { isIP } from "node:net";
import {
  ModelError,
  addRelation,
  findCI,
  listCIs,
  listRelations,
  removeRelation,
  upsertCI,
  type CI,
  type Value,
} from "@/lib/cmdb";
import { type CIType } from "@/lib/model";
import { sanitizeItem } from "@/lib/sanitize-item";
export { sanitizeItem } from "@/lib/sanitize-item";
import {
  syncSoftwarePackages,
  type SoftwarePackageReport,
} from "@/lib/software";
import { parseServices, syncServices } from "@/lib/services";
import { parseVirtualMachines, syncVirtualMachines } from "@/lib/hypervisor";

export async function ingestItem(item: unknown): Promise<{
  type: CIType;
  name: string;
  result: "created" | "updated" | "unchanged";
  networks?: number;
  packages?: number;
  services?: number;
  virtualMachines?: number;
}> {
  const { type, name, values } = sanitizeItem(item);
  const rawVMs = (item as Record<string, unknown>).virtualMachines;
  const vms = rawVMs === undefined ? undefined : parseVirtualMachines(rawVMs);
  if (vms !== undefined && type !== "Device") {
    throw new ModelError("VM-Inventar ist nur für Geräte als Hypervisor-Host erlaubt.");
  }
  const rawNetwork = (item as Record<string, unknown>).network;
  const info = rawNetwork === undefined ? undefined : parseNetwork(rawNetwork);
  const rawPackages = (item as Record<string, unknown>).packages;
  const packages = rawPackages === undefined ? undefined : parsePackages(rawPackages);
  const rawServices = (item as Record<string, unknown>).services;
  const services = rawServices === undefined ? undefined : parseServices(rawServices);
  if (info && type !== "Device" && type !== "VirtualMachine") {
    throw new ModelError("Netzwerkinformationen sind nur für Geräte und virtuelle Maschinen erlaubt.");
  }
  if (packages !== undefined && type !== "Device" && type !== "VirtualMachine") {
    throw new ModelError("Softwarepakete sind nur für Geräte und virtuelle Maschinen erlaubt.");
  }
  if (services !== undefined && type !== "Device" && type !== "VirtualMachine") {
    throw new ModelError("Services sind nur für Geräte und virtuelle Maschinen erlaubt.");
  }
  if (services && packages) {
    const available = new Set(packages.map((pkg) => `${pkg.name}\0${pkg.architecture}`));
    for (const service of services) {
      for (const pkg of service.packages) {
        if (!available.has(`${pkg.name}\0${pkg.architecture}`)) {
          throw new ModelError(`Service ${service.key}: Paket ${pkg.name}:${pkg.architecture} fehlt im Report.`);
        }
      }
    }
  }
  if (info) Object.assign(values, networkValues(info));

  const result = await upsertCI(type, name, values);
  if (!info && packages === undefined && services === undefined && vms === undefined) return { type, name, result };
  const host = await findCI(type, name);
  if (!host) throw new ModelError("CI nach dem Speichern nicht gefunden.");
  const [networks, packageCount] = await Promise.all([
    info ? syncNetworks(host, info) : Promise.resolve(undefined),
    packages !== undefined
      ? syncSoftwarePackages(host, packages)
      : Promise.resolve(undefined),
  ]);
  const serviceCount = services !== undefined ? await syncServices(host, services, packages !== undefined) : undefined;
  const vmCount = vms !== undefined ? await syncVirtualMachines(host, vms) : undefined;
  return { type, name, result, networks, packages: packageCount, services: serviceCount, virtualMachines: vmCount };
}

function parsePackages(raw: unknown): SoftwarePackageReport[] {
  if (!Array.isArray(raw) || raw.length > 5000) {
    throw new ModelError("packages muss eine Liste mit höchstens 5000 Einträgen sein.");
  }
  const packages = raw.map((entry, index): SoftwarePackageReport => {
    const where = `packages[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ModelError(`${where}: Objekt erforderlich.`);
    }
    const item = entry as Record<string, unknown>;
    const name = String(item.name ?? "").trim();
    const version = String(item.version ?? "").trim();
    const architecture = String(item.architecture ?? "").trim();
    if (!name || name.length > 200 || !/^[a-z0-9][a-z0-9+._-]*$/i.test(name)) {
      throw new ModelError(`${where}.name ungültig.`);
    }
    if (!version || version.length > 200) {
      throw new ModelError(`${where}.version fehlt oder ist zu lang.`);
    }
    if (!architecture || architecture.length > 64 || !/^[a-z0-9][a-z0-9_-]*$/i.test(architecture)) {
      throw new ModelError(`${where}.architecture ungültig.`);
    }
    const rawDepends = item.depends;
    if (rawDepends !== undefined && (!Array.isArray(rawDepends) || rawDepends.length > 256)) {
      throw new ModelError(`${where}.depends muss eine Liste mit höchstens 256 Paketen sein.`);
    }
    const depends = (rawDepends ?? []).map((dependency): { name: string; architecture: string } => {
      if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) {
        throw new ModelError(`${where}.depends enthält einen ungültigen Eintrag.`);
      }
      const target = dependency as Record<string, unknown>;
      const targetName = String(target.name ?? "");
      const targetArchitecture = String(target.architecture ?? "");
      if (
        !/^[a-z0-9][a-z0-9+._-]*$/i.test(targetName) ||
        !/^[a-z0-9][a-z0-9_-]*$/i.test(targetArchitecture)
      ) {
        throw new ModelError(`${where}.depends enthält einen ungültigen Paketbezug.`);
      }
      return { name: targetName, architecture: targetArchitecture };
    });
    return {
      name,
      version,
      architecture,
      ...(rawDepends === undefined ? {} : { depends: [...new Map(depends.map((dep) => [`${dep.name}\0${dep.architecture}`, dep])).values()] }),
    };
  });
  const dependencyCount = packages.reduce((sum, pkg) => sum + (pkg.depends?.length ?? 0), 0);
  if (dependencyCount > 25_000) {
    throw new ModelError("packages enthält mehr als 25000 Abhängigkeiten.");
  }
  const identities = new Set<string>();
  for (const pkg of packages) {
    const key = `${pkg.name}\0${pkg.architecture}`;
    if (identities.has(key)) {
      throw new ModelError(`Paket ${pkg.name} (${pkg.architecture}) ist mehrfach enthalten.`);
    }
    identities.add(key);
  }
  const available = new Set(identities);
  for (const pkg of packages) {
    for (const dependency of pkg.depends ?? []) {
      if (!available.has(`${dependency.name}\0${dependency.architecture}`)) {
        throw new ModelError(`Abhängigkeit ${dependency.name} von ${pkg.name} ist nicht in packages enthalten.`);
      }
    }
  }
  return packages;
}

interface NetAddress {
  ip: string;
  prefix: number;
}
interface NetInterface {
  name: string;
  mac?: string;
  state?: string;
  speedMbps?: number;
  addresses: NetAddress[];
}
interface NetInfo {
  interfaces: NetInterface[];
  gateway?: string;
  dns: string[];
}

const IFACE_NAME = /^[A-Za-z0-9_.:@-]{1,32}$/;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

function parseNetwork(raw: unknown): NetInfo {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModelError("network muss ein Objekt sein.");
  }
  const obj = raw as Record<string, unknown>;
  const list = obj.interfaces ?? [];
  if (!Array.isArray(list) || list.length > 64) {
    throw new ModelError("network.interfaces: Liste mit höchstens 64 Einträgen erforderlich.");
  }
  const interfaces = list.map((entry, index): NetInterface => {
    const where = `network.interfaces[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ModelError(`${where}: Objekt erforderlich.`);
    }
    const e = entry as Record<string, unknown>;
    const name = String(e.name ?? "");
    if (!IFACE_NAME.test(name)) throw new ModelError(`${where}.name ungültig.`);
    const mac = e.mac ? String(e.mac) : undefined;
    if (mac !== undefined && !MAC.test(mac)) throw new ModelError(`${where}.mac ungültig.`);
    const state = e.state ? String(e.state).slice(0, 16) : undefined;
    const speed = e.speedMbps;
    if (speed !== undefined && speed !== null && (!Number.isInteger(speed) || (speed as number) < 0 || (speed as number) > 10_000_000)) {
      throw new ModelError(`${where}.speedMbps ungültig.`);
    }
    const rawAddresses = e.addresses ?? [];
    if (!Array.isArray(rawAddresses) || rawAddresses.length > 32) {
      throw new ModelError(`${where}.addresses: höchstens 32 Einträge.`);
    }
    const addresses = rawAddresses.map((a): NetAddress => {
      const o = (a ?? {}) as Record<string, unknown>;
      const ip = String(o.ip ?? "");
      const version = isIP(ip);
      const prefix = o.prefix;
      if (!version || typeof prefix !== "number" || !Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128)) {
        throw new ModelError(`${where}: ungültige Adresse.`);
      }
      return { ip, prefix };
    });
    return { name, mac: mac?.toLowerCase(), state, speedMbps: typeof speed === "number" ? speed : undefined, addresses };
  });

  const gateway = obj.gateway ? String(obj.gateway) : undefined;
  if (gateway !== undefined && !isIP(gateway)) throw new ModelError("network.gateway ungültig.");
  const dns = obj.dns ?? [];
  if (!Array.isArray(dns) || dns.length > 8 || dns.some((d) => !isIP(String(d)))) {
    throw new ModelError("network.dns: höchstens 8 gültige IP-Adressen.");
  }
  return { interfaces, gateway, dns: dns.map(String) };
}

// Link-lokale und Loopback-Adressen sind keine nützlichen CMDB-Daten.
function isRelevant(address: NetAddress): boolean {
  const { ip } = address;
  if (isIP(ip) === 4) return !ip.startsWith("127.") && !ip.startsWith("169.254.");
  const lower = ip.toLowerCase();
  return lower !== "::1" && !lower.startsWith("fe80:");
}

function networkValues(info: NetInfo): Record<string, Value> {
  const lines = info.interfaces.map((i) => {
    const addresses = i.addresses.filter(isRelevant).map((a) => `${a.ip}/${a.prefix}`);
    return [
      i.name,
      i.mac ?? "-",
      i.state ?? "-",
      i.speedMbps ? `${i.speedMbps} Mbit/s` : "-",
      addresses.join(", ") || "-",
    ].join("  ");
  });
  const values: Record<string, Value> = { interfaces: lines.join("\n").slice(0, 5000) };
  if (info.gateway) values.gateway = info.gateway;
  if (info.dns.length) values.dnsServers = info.dns.join(", ").slice(0, 200);
  return values;
}

function ipv4Network(ip: string, prefix: number): string {
  const [a, b, c, d] = ip.split(".").map(Number);
  const address = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (address & mask) >>> 0;
  return `${net >>> 24}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${prefix}`;
}

// Verknüpft das CI mit dem Netzwerk jedes IPv4-Subnetzes (member_of, Attribut ip) und legt
// unbekannte Netzwerke an. Beziehungen mit IP, die nicht mehr zutreffen, werden entfernt;
// manuell angelegte Beziehungen ohne IP bleiben unberührt.
async function syncNetworks(host: CI, info: NetInfo): Promise<number> {
  const groups = new Map<string, string[]>();
  for (const iface of info.interfaces) {
    for (const address of iface.addresses) {
      if (isIP(address.ip) !== 4 || !isRelevant(address) || address.prefix < 8 || address.prefix > 31) continue;
      const cidr = ipv4Network(address.ip, address.prefix);
      const ips = groups.get(cidr) ?? [];
      if (!ips.includes(address.ip)) ips.push(address.ip);
      groups.set(cidr, ips);
    }
  }

  const known = await listCIs({ type: "Network" });
  const relations = (await listRelations(host.id)).filter(
    (r) => r.kind === "member_of" && r.direction === "out",
  );
  const wanted = new Set<string>();

  for (const [cidr, ips] of groups) {
    let network = known.find((n) => n.values.cidr === cidr);
    if (!network) {
      await upsertCI("Network", cidr, { cidr });
      network = (await findCI("Network", cidr)) ?? undefined;
      if (!network) throw new ModelError(`Netzwerk ${cidr} konnte nicht angelegt werden.`);
    }
    wanted.add(network.id);
    const ip = ips.join(", ");
    const existing = relations.filter((r) => r.otherId === network.id);
    if (existing.length === 1 && existing[0].attrs.ip === ip) continue;
    for (const r of existing) await removeRelation(r.id);
    await addRelation({ fromId: host.id, toId: network.id, kind: "member_of", attrs: { ip } });
  }

  for (const r of relations) {
    if (!wanted.has(r.otherId) && r.attrs.ip) await removeRelation(r.id);
  }
  return groups.size;
}
