import "server-only";
import { command, query } from "@/lib/arcadedb";
import {
  CI_TYPES,
  RELATION_FIELDS,
  RELATION_KINDS,
  isAllowedRelation,
  isCIType,
  isRelationKind,
  type CIType,
  type RelationKind,
} from "@/lib/model";

export type Value = string | number | null | undefined;

export interface CI {
  id: string;
  type: CIType;
  name: string;
  values: Record<string, Value>;
}

export interface RelationEntry {
  id: string;
  kind: RelationKind;
  direction: "out" | "in";
  otherId: string;
  otherName: string;
  otherType: CIType;
  otherHeightU?: number;
  attrs: Record<string, string | number>;
}

export interface PathEntry {
  id: string;
  name: string;
  type: CIType;
}

// Fachliche Regelverletzung, die dem Nutzer direkt angezeigt werden darf.
export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelError";
  }
}

const RID = /^#?\d+:\d+$/;
const IDENT = /^[A-Za-z][A-Za-z0-9]*$/;

export function toUrlId(rid: string): string {
  return rid.replace(/^#/, "");
}

export function isValidId(id: string): boolean {
  return RID.test(id);
}

function toRid(id: string): string {
  if (!isValidId(id)) throw new ModelError(`Ungültige ID: ${id}`);
  return id.startsWith("#") ? id : `#${id}`;
}

function assertIdent(name: string): string {
  if (!IDENT.test(name)) throw new ModelError(`Ungültiger Feldname: ${name}`);
  return name;
}

function toCI(row: Record<string, unknown>): CI | null {
  const type = String(row["@type"] ?? "");
  if (!isCIType(type)) return null;
  const values: Record<string, Value> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("@") || key === "name") continue;
    if (key === "createdAt" || key === "updatedAt") continue;
    values[key] = value as Value;
  }
  return {
    id: toUrlId(String(row["@rid"])),
    type,
    name: String(row.name ?? ""),
    values,
  };
}

export async function listCIs(
  filter: { q?: string; type?: string; excludeInstallations?: boolean } = {},
): Promise<CI[]> {
  const from = filter.type && isCIType(filter.type) ? filter.type : "CI";
  const params: Record<string, unknown> = {};
  const conditions: string[] = [];
  if (filter.q) {
    conditions.push("name.toLowerCase() LIKE :q");
    params.q = `%${filter.q.toLowerCase()}%`;
  }
  if (filter.excludeInstallations && from === "CI") {
    conditions.push("@type <> 'SoftwarePackage'");
  }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows = await query<Record<string, unknown>>(
    `SELECT FROM ${from}${where} ORDER BY name`,
    params,
  );
  return rows.map(toCI).filter((ci): ci is CI => ci !== null);
}

export interface CIOption {
  id: string;
  type: CIType;
  name: string;
}

export interface CIPageItem extends CIOption {
  status: string;
  owner: string;
}

export async function listCIPage(type: CIType, page: number, search: string): Promise<{
  items: CIPageItem[];
  hasNext: boolean;
}> {
  const pageSize = 50;
  const where = search ? " WHERE name.toLowerCase() LIKE :q" : "";
  const rows = await query<Record<string, unknown>>(
    `SELECT @rid, name, status, owner FROM ${type}${where} ORDER BY name, @rid SKIP ${(page - 1) * pageSize} LIMIT ${pageSize + 1}`,
    search ? { q: `%${search.toLowerCase()}%` } : {},
    "sql",
    pageSize + 1,
  );
  return {
    items: rows.slice(0, pageSize).map((row) => ({
      id: toUrlId(String(row["@rid"])),
      type,
      name: String(row.name ?? ""),
      status: String(row.status ?? ""),
      owner: String(row.owner ?? ""),
    })),
    hasNext: rows.length > pageSize,
  };
}

export async function listCIOptions(types: readonly CIType[]): Promise<CIOption[]> {
  if (types.length === 0) return [];
  const rows = await query<Record<string, unknown>>(
    "SELECT @rid, @type, name FROM CI WHERE @type IN :types ORDER BY name",
    { types },
  );
  return rows.flatMap((row) => {
    const type = String(row["@type"] ?? "");
    return isCIType(type) ? [{ id: toUrlId(String(row["@rid"])), type, name: String(row.name ?? "") }] : [];
  });
}

export interface SoftwareInstallation {
  relationId: string;
  id: string;
  name: string;
  version: string;
  architecture: string;
  hosts: { id: string; name: string; type: CIType }[];
}

export async function listSoftwareInstallations(softwareId: string): Promise<SoftwareInstallation[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT @rid AS relationId, @out AS id, @out.name AS name, @out.version AS version, @out.architecture AS architecture
     FROM Relation WHERE kind = 'installation_of' AND @in = :rid`,
    { rid: toRid(softwareId) },
  );
  const ids = [...new Set(rows.map((row) => String(row.id)))];
  const hostEdges = ids.length ? await query<Record<string, unknown>>(
    `SELECT @out AS installationId, @in AS id, @in.name AS name, @in.@type AS type
     FROM Relation WHERE kind = 'installed_on' AND @out IN :ids`,
    { ids },
  ) : [];
  const hosts = new Map<string, { id: string; name: string; type: CIType }[]>();
  for (const edge of hostEdges) {
    const id = toUrlId(String(edge.installationId));
    const type = String(edge.type ?? "");
    if (!isCIType(type)) throw new ModelError(`Ungültiger CI-Typ für System ${String(edge.id)}: ${type}`);
    const list = hosts.get(id) ?? [];
    list.push({ id: toUrlId(String(edge.id)), name: String(edge.name ?? ""), type });
    hosts.set(id, list);
  }
  return rows.map((row) => {
    const id = toUrlId(String(row.id));
    return {
      relationId: toUrlId(String(row.relationId)),
      id,
      name: String(row.name ?? ""),
      version: String(row.version ?? ""),
      architecture: String(row.architecture ?? ""),
      hosts: hosts.get(id) ?? [],
    };
  }).sort((a, b) => (a.hosts[0]?.name ?? "").localeCompare(b.hosts[0]?.name ?? "") || a.name.localeCompare(b.name));
}

export async function getCI(id: string): Promise<CI | null> {
  if (!isValidId(id)) return null;
  const rows = await query<Record<string, unknown>>(
    "SELECT FROM CI WHERE @rid = :rid",
    { rid: toRid(id) },
  );
  return rows[0] ? toCI(rows[0]) : null;
}

export async function createCI(
  type: CIType,
  name: string,
  values: Record<string, Value>,
): Promise<string> {
  const entries = Object.entries(values).filter(([, v]) => v != null);
  const sets = entries.map(([key]) => `${assertIdent(key)} = :${key}`);
  const rows = await command<{ "@rid": string }>(
    `CREATE VERTEX ${type} SET ${["name = :name", ...sets, "createdAt = sysdate()", "updatedAt = sysdate()"].join(", ")}`,
    { name, ...Object.fromEntries(entries) },
  );
  return toUrlId(rows[0]["@rid"]);
}

export type UpsertResult = "created" | "updated" | "unchanged";

export async function findCI(type: CIType, name: string): Promise<CI | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT FROM ${type} WHERE name = :name LIMIT 2`,
    { name },
  );
  if (rows.length > 1) throw new ModelError(`${type} "${name}" ist nicht eindeutig.`);
  return rows[0] ? toCI(rows[0]) : null;
}

// Legt ein CI anhand (Typ, Name) an oder aktualisiert nur die übergebenen Felder.
export async function upsertCI(
  type: CIType,
  name: string,
  values: Record<string, Value>,
): Promise<UpsertResult> {
  const rows = await query<Record<string, unknown>>(
    `SELECT FROM ${type} WHERE name = :name LIMIT 2`,
    { name },
  );
  if (rows.length > 1) throw new ModelError(`${type} "${name}" ist nicht eindeutig.`);
  const ci = rows[0] ? toCI(rows[0]) : null;
  if (type === "VirtualMachine" && ci?.values.hypervisorSource) {
    throw new ModelError(`VM "${name}" wird durch einen Hypervisor verwaltet; Import nach Namen ist nicht erlaubt.`);
  }
  const provided = Object.entries(values).filter(([, v]) => v != null);

  if (!ci) {
    await createCI(type, name, { status: "Active", ...Object.fromEntries(provided) });
    return "created";
  }
  const changed = provided.filter(([key, v]) => ci.values[key] !== v);
  if (changed.length === 0) return "unchanged";
  await updateCI(ci, name, Object.fromEntries(changed));
  return "updated";
}

export async function updateCI(
  ci: CI,
  name: string,
  values: Record<string, Value>,
): Promise<void> {
  const sets = Object.keys(values).map((key) => `${assertIdent(key)} = :${key}`);
  await command(
    `UPDATE ${ci.type} SET ${["name = :name", ...sets, "updatedAt = sysdate()"].join(", ")} WHERE @rid = :rid`,
    { name, ...values, rid: toRid(ci.id) },
  );
}

export async function deleteCI(id: string): Promise<void> {
  const rid = toRid(id);
  const [{ c }] = await query<{ c: number }>(
    "SELECT count(*) AS c FROM Relation WHERE @in = :rid AND kind IN ['located_in', 'hosted_on', 'installed_on', 'installation_of', 'service_on']",
    { rid },
  );
  if (c > 0) {
    throw new ModelError(
      "Dieses CI enthält oder hostet noch andere CIs oder Softwareinstallationen. Bitte diese zuerst verschieben oder löschen.",
    );
  }
  await command("DELETE VERTEX FROM CI WHERE @rid = :rid", { rid });
}

const ATTR_SELECT = Object.keys(RELATION_FIELDS).join(", ");

function toEntry(
  row: Record<string, unknown>,
  direction: "out" | "in",
): RelationEntry | null {
  const kind = String(row.kind);
  const otherType = String(row.otherType);
  if (!isRelationKind(kind) || !isCIType(otherType)) return null;
  const attrs: Record<string, string | number> = {};
  for (const key of Object.keys(RELATION_FIELDS)) {
    const value = row[key];
    if (value !== null && value !== undefined && value !== "") {
      attrs[key] = value as string | number;
    }
  }
  return {
    id: toUrlId(String(row.id)),
    kind,
    direction,
    otherId: toUrlId(String(row.otherId)),
    otherName: String(row.otherName ?? ""),
    otherType,
    otherHeightU:
      typeof row.otherHeightU === "number" ? row.otherHeightU : undefined,
    attrs,
  };
}

export async function listRelations(id: string): Promise<RelationEntry[]> {
  const rid = toRid(id);
  const [outgoing, incoming] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT @rid AS id, kind, ${ATTR_SELECT}, @in AS otherId, @in.name AS otherName,
         @in.@type AS otherType, @in.heightU AS otherHeightU
       FROM Relation WHERE @out = :rid`,
      { rid },
    ),
    query<Record<string, unknown>>(
      `SELECT @rid AS id, kind, ${ATTR_SELECT}, @out AS otherId, @out.name AS otherName,
         @out.@type AS otherType, @out.heightU AS otherHeightU
       FROM Relation WHERE @in = :rid`,
      { rid },
    ),
  ]);
  return [
    ...outgoing.map((r) => toEntry(r, "out")),
    ...incoming.map((r) => toEntry(r, "in")),
  ]
    .filter((e): e is RelationEntry => e !== null)
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        Number(a.attrs.rackUnit ?? 0) - Number(b.attrs.rackUnit ?? 0) ||
        a.otherName.localeCompare(b.otherName),
    );
}

// Standortpfad von oben nach unten (Standort > Raum > Rack > …), ohne das CI selbst.
export async function locationPath(id: string): Promise<PathEntry[]> {
  const path: PathEntry[] = [];
  let current = toRid(id);
  for (let depth = 0; depth < 6; depth++) {
    const rows = await query<Record<string, unknown>>(
      `SELECT @in AS id, @in.name AS name, @in.@type AS type
       FROM Relation WHERE kind = 'located_in' AND @out = :rid`,
      { rid: current },
    );
    const parent = rows[0];
    if (!parent || !isCIType(String(parent.type))) break;
    path.unshift({
      id: toUrlId(String(parent.id)),
      name: String(parent.name),
      type: parent.type as CIType,
    });
    current = String(parent.id);
  }
  return path;
}

async function count(sql: string, params: Record<string, unknown>) {
  const [row] = await query<{ c: number }>(sql, params);
  return row?.c ?? 0;
}

async function assertRackPlacement(
  device: CI,
  rack: CI,
  rackUnit: number | undefined,
) {
  if (rackUnit === undefined) {
    throw new ModelError("Für den Einbau in ein Rack ist die unterste HE erforderlich.");
  }
  const deviceHeight = Number(device.values.heightU ?? 1);
  const rackHeight = Number(rack.values.heightU ?? 42);
  const end = rackUnit + deviceHeight - 1;
  if (end > rackHeight) {
    throw new ModelError(
      `Passt nicht ins Rack: ${device.name} belegt HE ${rackUnit}–${end}, ${rack.name} hat nur ${rackHeight} HE.`,
    );
  }
  const placed = await query<{ rackUnit: number; h: number | null; name: string }>(
    `SELECT rackUnit, @out.heightU AS h, @out.name AS name FROM Relation
     WHERE kind = 'located_in' AND @in = :rack AND rackUnit IS NOT NULL`,
    { rack: toRid(rack.id) },
  );
  for (const other of placed) {
    const otherEnd = other.rackUnit + Number(other.h ?? 1) - 1;
    if (rackUnit <= otherEnd && other.rackUnit <= end) {
      throw new ModelError(
        `Kollidiert mit ${other.name} (HE ${other.rackUnit}–${otherEnd}).`,
      );
    }
  }
}

export async function addRelation(input: {
  fromId: string;
  toId: string;
  kind: RelationKind;
  attrs: Record<string, string | number | undefined>;
}): Promise<void> {
  const { kind } = input;
  const [from, to] = await Promise.all([getCI(input.fromId), getCI(input.toId)]);
  if (!from || !to) throw new ModelError("CI nicht gefunden.");
  if (from.id === to.id) {
    throw new ModelError("Ein CI kann nicht mit sich selbst verknüpft werden.");
  }
  const def = RELATION_KINDS[kind];
  if (!isAllowedRelation(kind, from.type, to.type)) {
    throw new ModelError(
      `„${def.label}“ ist zwischen ${CI_TYPES[from.type].label} und ${CI_TYPES[to.type].label} nicht erlaubt.`,
    );
  }

  const fromRid = toRid(from.id);
  const toRidValue = toRid(to.id);
  if ("single" in def && def.single) {
    const existing = await count(
      "SELECT count(*) AS c FROM Relation WHERE kind = :kind AND @out = :from",
      { kind, from: fromRid },
    );
    if (existing > 0) {
      throw new ModelError(
        `${from.name} hat bereits eine Beziehung „${def.label}“. Bitte zuerst die bestehende entfernen.`,
      );
    }
  }
  if (kind !== "connected_to") {
    const duplicate = await count(
      "SELECT count(*) AS c FROM Relation WHERE kind = :kind AND @out = :from AND @in = :to",
      { kind, from: fromRid, to: toRidValue },
    );
    if (duplicate > 0) throw new ModelError("Diese Beziehung existiert bereits.");
  }

  const allowed = new Set<string>(def.fields);
  const attrs = Object.fromEntries(
    Object.entries(input.attrs).filter(
      ([key, value]) => allowed.has(key) && value !== undefined,
    ),
  );
  if (kind === "located_in" && from.type === "Device" && to.type === "Rack") {
    await assertRackPlacement(from, to, attrs.rackUnit as number | undefined);
  } else {
    delete attrs.rackUnit;
  }

  const sets = ["kind = :kind", ...Object.keys(attrs).map((k) => `${assertIdent(k)} = :${k}`)];
  await command(
    `CREATE EDGE Relation
       FROM (SELECT FROM CI WHERE @rid = :from)
       TO (SELECT FROM CI WHERE @rid = :to)
       SET ${sets.join(", ")}`,
    { ...attrs, kind, from: fromRid, to: toRidValue },
  );
}

export async function removeRelation(relationId: string): Promise<void> {
  await command("DELETE FROM Relation WHERE @rid = :rid", {
    rid: toRid(relationId),
  });
}
