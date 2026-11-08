import "server-only";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { batch, query } from "@/lib/arcadedb";
import { ModelError, type CI } from "@/lib/cmdb";

export interface ServiceReport {
  key: string;
  bindings: { protocol: "tcp" | "udp"; address: string; port: number }[];
  executables: string[];
  packages: { name: string; architecture: string }[];
}

const source = "linux-agent";
const asObject = (value: unknown, where: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelError(`${where}: Objekt erforderlich.`);
  }
  return value as Record<string, unknown>;
};
const text = (value: unknown, where: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw new ModelError(`${where}: ungültiger Text.`);
  }
  return value;
};
const idOf = (value: unknown) => String(value ?? "").replace(/^#/, "");
const rid = (value: string) => `#${idOf(value)}`;
const pair = (from: string, to: string) => `${from}|${to}`;
const packageKey = (name: string, architecture: string) => `${name}\0${architecture}`;

export function parseServices(raw: unknown): ServiceReport[] {
  if (!Array.isArray(raw) || raw.length > 1000) {
    throw new ModelError("services muss eine Liste mit höchstens 1000 Einträgen sein.");
  }
  const keys = new Set<string>();
  return raw.map((entry, index) => {
    const where = `services[${index}]`;
    const object = asObject(entry, where);
    const key = text(object.key, `${where}.key`, 200);
    if (keys.has(key)) throw new ModelError(`${where}.key ist mehrfach vorhanden.`);
    keys.add(key);
    if (!Array.isArray(object.bindings) || !object.bindings.length || object.bindings.length > 256) {
      throw new ModelError(`${where}.bindings: 1 bis 256 Einträge erforderlich.`);
    }
    const bindings = object.bindings.map((value): ServiceReport["bindings"][number] => {
      const b = asObject(value, `${where}.bindings`);
      if (b.protocol !== "tcp" && b.protocol !== "udp") throw new ModelError(`${where}: ungültiges Protokoll.`);
      const address = text(b.address, `${where}.address`, 100);
      const [ip, zone, ...extra] = address.split("%");
      if (extra.length || (address !== "*" && !isIP(ip)) || (zone !== undefined && !/^[\w.-]+$/.test(zone))) {
        throw new ModelError(`${where}: ungültige Bindungsadresse.`);
      }
      if (typeof b.port !== "number" || !Number.isInteger(b.port) || b.port < 1 || b.port > 65535) {
        throw new ModelError(`${where}: ungültiger Port.`);
      }
      return { protocol: b.protocol, address, port: b.port };
    });
    if (!Array.isArray(object.executables) || object.executables.length > 64) {
      throw new ModelError(`${where}.executables: höchstens 64 Einträge.`);
    }
    const executables = object.executables.map((v) => text(v, `${where}.executables`, 500));
    if (!Array.isArray(object.packages) || object.packages.length > 64) {
      throw new ModelError(`${where}.packages: höchstens 64 Einträge.`);
    }
    const packages = object.packages.map((v) => {
      const p = asObject(v, `${where}.packages`);
      const name = text(p.name, `${where}.packages.name`, 200);
      const architecture = text(p.architecture, `${where}.packages.architecture`, 64);
      if (!/^[a-z0-9][a-z0-9+._-]*$/i.test(name) || !/^[a-z0-9][a-z0-9_-]*$/i.test(architecture)) {
        throw new ModelError(`${where}.packages: ungültiger Paketbezug.`);
      }
      return { name, architecture };
    });
    const uniqueBindings = [...new Map(bindings.map((b) => [`${b.protocol}|${b.address}|${b.port}`, b])).values()]
      .sort((a, b) => a.protocol.localeCompare(b.protocol) || a.address.localeCompare(b.address) || a.port - b.port);
    const uniqueExecutables = [...new Set(executables)].sort();
    const uniquePackages = [...new Map(packages.map((p) => [packageKey(p.name, p.architecture), p])).values()];
    if (formatBindings(uniqueBindings).length > 5000 || uniqueExecutables.join("\n").length > 5000) {
      throw new ModelError(`${where}: zu viele Bindungen oder ausführbare Dateien.`);
    }
    return { key, bindings: uniqueBindings, executables: uniqueExecutables, packages: uniquePackages };
  });
}

function formatBindings(bindings: ServiceReport["bindings"]): string {
  return bindings.map((b) => {
    const address = b.address.includes(":") ? `[${b.address}]` : b.address;
    return `${b.protocol.toUpperCase()} ${address}:${b.port}`;
  }).join("\n");
}

interface ServiceRow {
  "@rid": string;
  name: string;
  serviceKey: string;
  bindings: string;
  executables: string;
  status: string;
}
interface EdgeRow {
  id: string;
  fromId: string;
  toId: string;
  discoverySource?: string;
  kind: string;
}
interface Statement {
  sql: string;
  params: Record<string, unknown>;
}
async function runBatches(statements: Statement[]) {
  for (let i = 0; i < statements.length; i += 200) {
    const chunk = statements.slice(i, i + 200);
    await batch(`${chunk.map((s) => s.sql).join(";\n")};`, Object.assign({}, ...chunk.map((s) => s.params)));
  }
}

let serviceSyncQueue: Promise<void> = Promise.resolve();

export async function syncServices(host: CI, reports: ServiceReport[], hasPackageInventory: boolean): Promise<number> {
  const previous = serviceSyncQueue;
  let release!: () => void;
  serviceSyncQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await syncServicesUnlocked(host, reports, hasPackageInventory);
  } finally {
    release();
  }
}

async function syncServicesUnlocked(host: CI, reports: ServiceReport[], hasPackageInventory: boolean): Promise<number> {
  const installations = await query<{ "@rid": string; packageName: string; architecture: string }>(
    "SELECT @rid, packageName, architecture FROM SoftwarePackage WHERE hostId = :hostId LIMIT 10000",
    { hostId: host.id },
  );
  const packages = new Map(installations.map((p) => [packageKey(p.packageName, p.architecture), idOf(p["@rid"])]));
  for (const service of reports) {
    for (const p of service.packages) {
      if (!packages.has(packageKey(p.name, p.architecture))) {
        throw new ModelError(`Service ${service.key}: Paket ${p.name}:${p.architecture} ist auf diesem System nicht installiert.`);
      }
    }
  }

  const readServices = async () => {
    const [count] = await query<{ c: number }>(
      "SELECT count(*) AS c FROM Service WHERE hostId = :hostId AND discoverySource = :source",
      { hostId: host.id, source },
    );
    if (!count || count.c > 5000) throw new ModelError("Zu viele Services für dieses System (höchstens 5000).");
    const rows = await query<ServiceRow>(
      "SELECT @rid, name, serviceKey, bindings, executables, status FROM Service WHERE hostId = :hostId AND discoverySource = :source LIMIT 5000",
      { hostId: host.id, source },
      "sql",
      5000,
    );
    if (rows.length !== count.c) throw new ModelError("Service-Inventur ist unvollständig oder wurde gleichzeitig geändert.");
    return rows;
  };
  const existing = await readServices();
  const byKey = new Map<string, ServiceRow>();
  for (const row of existing) {
    if (byKey.has(row.serviceKey)) throw new ModelError(`Service ${row.serviceKey} ist auf diesem System mehrfach vorhanden.`);
    byKey.set(row.serviceKey, row);
  }
  const desired = new Map(reports.map((report) => [report.key, report]));
  const writes: Statement[] = [];
  for (const [i, report] of reports.entries()) {
    const old = byKey.get(report.key);
    const bindings = formatBindings(report.bindings);
    const executables = report.executables.join("\n");
    const fullName = `${report.key} on ${host.name} [${host.id}]`;
    const name = fullName.length <= 200 ? fullName : `${fullName.slice(0, 187)}~${createHash("sha256").update(fullName).digest("hex").slice(0, 12)}`;
    if (old && old.name === name && old.bindings === bindings && (old.executables ?? "") === executables && old.status === "Active") continue;
    const params = { [`n${i}`]: name, [`k${i}`]: report.key, [`h${i}`]: host.id, [`b${i}`]: bindings, [`x${i}`]: executables, [`s${i}`]: source };
    writes.push(old ? {
      sql: `UPDATE Service SET name = :n${i}, serviceKey = :k${i}, hostId = :h${i}, bindings = :b${i}, executables = :x${i}, discoverySource = :s${i}, status = 'Active', updatedAt = sysdate() WHERE @rid = :r${i}`,
      params: { ...params, [`r${i}`]: rid(old["@rid"]) },
    } : {
      sql: `CREATE VERTEX Service SET name = :n${i}, serviceKey = :k${i}, hostId = :h${i}, bindings = :b${i}, executables = :x${i}, discoverySource = :s${i}, status = 'Active', createdAt = sysdate(), updatedAt = sysdate()`,
      params,
    });
  }
  for (const [i, row] of existing.entries()) {
    if (!desired.has(row.serviceKey) && (row.status !== "Decommissioned" || row.bindings || row.executables)) {
      writes.push({
        sql: `UPDATE Service SET status = 'Decommissioned', bindings = '', executables = '', updatedAt = sysdate() WHERE @rid = :stale${i}`,
        params: { [`stale${i}`]: rid(row["@rid"]) },
      });
    }
  }
  await runBatches(writes);
  const current = await readServices();
  const ids = current.map((s) => rid(s["@rid"]));
  const edges = ids.length ? await query<EdgeRow>(
    "SELECT @rid AS id, @out AS fromId, @in AS toId, kind, discoverySource FROM Relation WHERE @out IN :ids AND kind IN ['service_on', 'provided_by'] LIMIT 100000",
    { ids },
    "sql",
    100000,
  ) : [];
  for (const edge of edges) {
    if (edge.kind === "service_on" && idOf(edge.toId) !== host.id && edge.discoverySource !== source) {
      throw new ModelError(`Service ${idOf(edge.fromId)} ist manuell einem anderen System zugeordnet.`);
    }
  }
  const wanted = new Map<string, { kind: string; from: string; to: string }>();
  for (const row of current) {
    const from = idOf(row["@rid"]);
    wanted.set(`service_on|${pair(from, host.id)}`, { kind: "service_on", from, to: host.id });
    for (const pkg of desired.get(row.serviceKey)?.packages ?? []) {
      const to = packages.get(packageKey(pkg.name, pkg.architecture));
      if (!to) throw new ModelError(`Paket ${pkg.name} nicht gefunden.`);
      wanted.set(`provided_by|${pair(from, to)}`, { kind: "provided_by", from, to });
    }
  }
  const existingEdges = new Set(edges.map((e) => `${e.kind}|${pair(idOf(e.fromId), idOf(e.toId))}`));
  const removals = edges.filter((e) =>
    e.discoverySource === source &&
    (hasPackageInventory || e.kind !== "provided_by") &&
    !wanted.has(`${e.kind}|${pair(idOf(e.fromId), idOf(e.toId))}`),
  );
  await runBatches(removals.map((e, i) => ({
    sql: `DELETE FROM Relation WHERE @rid = :d${i}`,
    params: { [`d${i}`]: rid(e.id) },
  })));
  const additions = [...wanted.entries()].filter(([key]) => !existingEdges.has(key));
  await runBatches(additions.map(([, edge], i) => ({
    sql: `CREATE EDGE Relation FROM (SELECT FROM CI WHERE @rid = :f${i}) TO (SELECT FROM CI WHERE @rid = :t${i}) SET kind = :k${i}, discoverySource = :s${i}`,
    params: { [`f${i}`]: rid(edge.from), [`t${i}`]: rid(edge.to), [`k${i}`]: edge.kind, [`s${i}`]: source },
  })));
  return reports.length;
}
