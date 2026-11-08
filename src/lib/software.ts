import "server-only";
import { createHash } from "node:crypto";
import { batch, query } from "@/lib/arcadedb";
import { ModelError, type CI, type Value } from "@/lib/cmdb";

export interface SoftwarePackageReport {
  name: string;
  version: string;
  architecture: string;
  depends?: { name: string; architecture: string }[];
}

interface PackageRow {
  "@rid": string;
  name: string;
  packageName: string;
  version: string;
  architecture: string;
  hostId: string;
  status: string;
}

interface RelationRow {
  id: string;
  fromId: string;
  toId: string;
}

const keyOf = (name: string, architecture: string) => `${name}\0${architecture}`;
const rid = (id: string) => (id.startsWith("#") ? id : `#${id}`);
const idOf = (id: unknown) => String(id ?? "").replace(/^#/, "");

function packageCIName(packageName: string, architecture: string, host: CI): string {
  const full = `${packageName}:${architecture} on ${host.name} [${host.id}]`;
  if (full.length <= 200) return full;
  const suffix = createHash("sha256").update(full).digest("hex").slice(0, 12);
  return `${full.slice(0, 187)}~${suffix}`;
}

async function runBatches(
  statements: { sql: string; params: Record<string, unknown> }[],
) {
  for (let start = 0; start < statements.length; start += 250) {
    const chunk = statements.slice(start, start + 250);
    await batch(
      `${chunk.map((statement) => statement.sql).join(";\n")};`,
      Object.assign({}, ...chunk.map((statement) => statement.params)),
    );
  }
}

async function readPackages(hostId: string): Promise<CI[]> {
  const rows = await query<PackageRow>(
    "SELECT @rid, name, packageName, version, architecture, hostId, status FROM SoftwarePackage WHERE hostId = :hostId LIMIT 10000",
    { hostId },
  );
  return rows.map((row) => ({
    id: idOf(row["@rid"]),
    type: "SoftwarePackage",
    name: String(row.name ?? ""),
    values: {
      packageName: row.packageName,
      version: row.version,
      architecture: row.architecture,
      hostId: row.hostId,
      status: row.status,
    },
  }));
}

function rowValues(name: string, hostId: string, pkg: SoftwarePackageReport) {
  const values: Record<string, Value> = {
    name,
    packageName: pkg.name,
    version: pkg.version,
    architecture: pkg.architecture,
    hostId,
    status: "Active",
  };
  return values;
}

function changed(row: CI, name: string, values: Record<string, Value>) {
  return row.name !== name || Object.entries(values).some(
    ([key, value]) => key !== "name" && row.values[key] !== value,
  );
}

function relationKey(fromId: string, toId: string) {
  return `${fromId}|${toId}`;
}

function edgeSql(index: number, kind: string, fromId: string, toId: string) {
  const prefix = `e${index}`;
  return {
    sql: `CREATE EDGE Relation FROM (SELECT FROM CI WHERE @rid = :${prefix}from) TO (SELECT FROM CI WHERE @rid = :${prefix}to) SET kind = :${prefix}kind`,
    params: {
      [`${prefix}from`]: rid(fromId),
      [`${prefix}to`]: rid(toId),
      [`${prefix}kind`]: kind,
    },
  };
}

let softwareSyncQueue: Promise<void> = Promise.resolve();

export async function syncSoftwarePackages(
  host: CI,
  packages: SoftwarePackageReport[],
): Promise<number> {
  const previous = softwareSyncQueue;
  let release!: () => void;
  softwareSyncQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await syncSoftwarePackagesUnlocked(host, packages);
  } finally {
    release();
  }
}

async function syncSoftwarePackagesUnlocked(
  host: CI,
  packages: SoftwarePackageReport[],
): Promise<number> {
  const hostId = host.id;
  const oldPackages = await readPackages(hostId);
  const existingByKey = new Map<string, CI>();
  for (const ci of oldPackages) {
    const key = keyOf(
      String(ci.values.packageName ?? ""),
      String(ci.values.architecture ?? ""),
    );
    if (existingByKey.has(key)) {
      throw new ModelError(`Doppeltes Softwarepaket im Bestand: ${ci.values.packageName}.`);
    }
    existingByKey.set(key, ci);
  }

  const wantedByKey = new Map<string, SoftwarePackageReport>();
  for (const pkg of packages) wantedByKey.set(keyOf(pkg.name, pkg.architecture), pkg);

  const names = [...new Set(packages.map((pkg) => pkg.name))];
  const readSoftware = () => names.length
    ? query<{ "@rid": string; name: string }>(
        "SELECT @rid, name FROM Software WHERE name IN :names LIMIT 10000",
        { names },
      )
    : Promise.resolve([]);
  const softwareByName = new Map<string, string>();
  for (const row of await readSoftware()) {
    if (softwareByName.has(row.name)) {
      throw new ModelError(`Softwarepaket "${row.name}" ist nicht eindeutig.`);
    }
    softwareByName.set(row.name, idOf(row["@rid"]));
  }
  await runBatches(
    names.filter((name) => !softwareByName.has(name)).map((name, i) => ({
      sql: `CREATE VERTEX Software SET name = :s${i}, status = 'Active', createdAt = sysdate(), updatedAt = sysdate()`,
      params: { [`s${i}`]: name },
    })),
  );
  for (const row of await readSoftware()) {
    softwareByName.set(row.name, idOf(row["@rid"]));
  }

  const upserts: { sql: string; params: Record<string, unknown> }[] = [];
  let index = 0;
  for (const [key, pkg] of wantedByKey) {
    const name = packageCIName(pkg.name, pkg.architecture, host);
    const existing = existingByKey.get(key);
    const values = rowValues(name, hostId, pkg);
    if (existing && !changed(existing, name, values)) continue;
    const prefix = `p${index++}`;
    const params = {
      [`${prefix}name`]: name,
      [`${prefix}packageName`]: pkg.name,
      [`${prefix}version`]: pkg.version,
      [`${prefix}architecture`]: pkg.architecture,
      [`${prefix}hostId`]: hostId,
    };
    if (existing) {
      upserts.push({
        sql: `UPDATE SoftwarePackage SET name = :${prefix}name, packageName = :${prefix}packageName, version = :${prefix}version, architecture = :${prefix}architecture, hostId = :${prefix}hostId, status = 'Active', updatedAt = sysdate() WHERE @rid = :${prefix}rid`,
        params: { ...params, [`${prefix}rid`]: rid(existing.id) },
      });
    } else {
      upserts.push({
        sql: `CREATE VERTEX SoftwarePackage SET name = :${prefix}name, packageName = :${prefix}packageName, version = :${prefix}version, architecture = :${prefix}architecture, hostId = :${prefix}hostId, status = 'Active', createdAt = sysdate(), updatedAt = sysdate()`,
        params,
      });
    }
  }
  await runBatches(upserts);

  const currentPackages = await readPackages(hostId);
  const currentByKey = new Map(
    currentPackages.map((ci) => [
      keyOf(String(ci.values.packageName), String(ci.values.architecture)),
      ci,
    ]),
  );
  const installedEdges = await query<RelationRow>(
    "SELECT @rid AS id, @out AS fromId, @in AS toId FROM Relation WHERE kind = 'installed_on' AND @in = :hostRid",
    { hostRid: rid(hostId) },
  );
  const packageIds = currentPackages.map((ci) => rid(ci.id));
  const dependencyEdges = packageIds.length
    ? await query<RelationRow>(
        "SELECT @rid AS id, @out AS fromId, @in AS toId FROM Relation WHERE kind = 'depends_on' AND @out IN :packageIds LIMIT 50000",
        { packageIds },
        "sql",
        50000,
      )
    : [];
  const softwareEdges = packageIds.length
    ? await query<RelationRow>(
        "SELECT @rid AS id, @out AS fromId, @in AS toId FROM Relation WHERE kind = 'installation_of' AND @out IN :packageIds LIMIT 10000",
        { packageIds },
      )
    : [];

  const desiredInstalled = new Set(currentPackages.filter((ci) => wantedByKey.has(
    keyOf(String(ci.values.packageName), String(ci.values.architecture)),
  )).map((ci) => relationKey(ci.id, hostId)));
  const desiredSoftware = new Set<string>();
  const desiredDependencies = new Set<string>();
  const dependenciesReported = new Set<string>();
  for (const pkg of wantedByKey.values()) {
    const source = currentByKey.get(keyOf(pkg.name, pkg.architecture));
    if (!source) throw new ModelError(`Softwarepaket ${pkg.name} konnte nicht gespeichert werden.`);
    const softwareId = softwareByName.get(pkg.name);
    if (!softwareId) throw new ModelError(`Softwarepaket ${pkg.name} konnte nicht angelegt werden.`);
    desiredSoftware.add(relationKey(source.id, softwareId));
    if (pkg.depends !== undefined) dependenciesReported.add(source.id);
    for (const target of pkg.depends ?? []) {
      const destination = currentByKey.get(keyOf(target.name, target.architecture));
      if (!destination) {
        throw new ModelError(`Abhängigkeit ${target.name} von ${pkg.name} ist nicht installiert.`);
      }
      if (source.id !== destination.id) {
        desiredDependencies.add(relationKey(source.id, destination.id));
      }
    }
  }

  const edgesToRemove = [
    ...installedEdges
      .filter((edge) => !desiredInstalled.has(relationKey(idOf(edge.fromId), idOf(edge.toId))))
      .map((edge) => edge.id),
    ...dependencyEdges
      .filter((edge) => dependenciesReported.has(idOf(edge.fromId)) && !desiredDependencies.has(relationKey(idOf(edge.fromId), idOf(edge.toId))))
      .map((edge) => edge.id),
    ...softwareEdges
      .filter((edge) => !desiredSoftware.has(relationKey(idOf(edge.fromId), idOf(edge.toId))))
      .map((edge) => edge.id),
  ];
  await runBatches(
    edgesToRemove.map((edgeId, i) => ({
      sql: `DELETE FROM Relation WHERE @rid = :d${i}`,
      params: { [`d${i}`]: rid(edgeId) },
    })),
  );

  const existingInstalled = new Set(
    installedEdges.map((edge) => relationKey(idOf(edge.fromId), idOf(edge.toId))),
  );
  const existingDependencies = new Set(
    dependencyEdges.map((edge) => relationKey(idOf(edge.fromId), idOf(edge.toId))),
  );
  const existingSoftware = new Set(
    softwareEdges.map((edge) => relationKey(idOf(edge.fromId), idOf(edge.toId))),
  );
  const edgesToAdd: { sql: string; params: Record<string, unknown> }[] = [];
  let edgeIndex = 0;
  for (const pair of desiredInstalled) {
    if (!existingInstalled.has(pair)) {
      const [fromId, toId] = pair.split("|");
      edgesToAdd.push(edgeSql(edgeIndex++, "installed_on", fromId, toId));
    }
  }
  for (const pair of desiredSoftware) {
    if (!existingSoftware.has(pair)) {
      const [fromId, toId] = pair.split("|");
      edgesToAdd.push(edgeSql(edgeIndex++, "installation_of", fromId, toId));
    }
  }
  for (const pair of desiredDependencies) {
    if (!existingDependencies.has(pair)) {
      const [fromId, toId] = pair.split("|");
      edgesToAdd.push(edgeSql(edgeIndex++, "depends_on", fromId, toId));
    }
  }
  await runBatches(edgesToAdd);

  const stalePackages = oldPackages.filter(
    (ci) => !wantedByKey.has(
      keyOf(String(ci.values.packageName ?? ""), String(ci.values.architecture ?? "")),
    ),
  );
  await runBatches(
    stalePackages.map((ci, i) => ({
      sql: `DELETE VERTEX FROM SoftwarePackage WHERE @rid = :x${i}`,
      params: { [`x${i}`]: rid(ci.id) },
    })),
  );

  return wantedByKey.size;
}
