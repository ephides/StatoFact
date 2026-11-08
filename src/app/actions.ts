"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  ModelError,
  addRelation,
  createCI,
  deleteCI,
  getCI,
  isValidId,
  listCIOptions,
  listCIPage,
  removeRelation,
  updateCI,
} from "@/lib/cmdb";
import {
  RELATION_FIELDS,
  RELATION_KINDS,
  fieldsFor,
  isCIType,
  isRelationKind,
  CI_TYPES,
  type CIType,
  type RelationKind,
} from "@/lib/model";
import { parseFields } from "@/lib/form";

export type FormState = { error?: string } | undefined;

export async function getCIPageAction(type: string, page: number, search: string) {
  if (!isCIType(type) || type === "SoftwarePackage") throw new ModelError("Ungültiger CI-Typ.");
  if (!Number.isSafeInteger(page) || page < 1 || page > 20000) throw new ModelError("Ungültige Seite.");
  if (typeof search !== "string" || search.length > 200) throw new ModelError("Ungültiger Suchbegriff.");
  return listCIPage(type, page, search.trim());
}

export interface RelationOptionGroup {
  label: string;
  options: { value: string; label: string }[];
}

export async function getRelationOptionsAction(id: string): Promise<RelationOptionGroup[]> {
  const self = await getCI(id);
  if (!self) throw new ModelError("CI nicht gefunden.");
  const types = new Set<CIType>();
  for (const kind of Object.keys(RELATION_KINDS) as RelationKind[]) {
    for (const [from, to] of RELATION_KINDS[kind].rules as readonly (readonly [CIType, CIType])[]) {
      if (self.type === from) types.add(to);
      if (self.type === to && from !== to) types.add(from);
    }
  }
  const all = await listCIOptions([...types]);
  const groups = new Map<string, RelationOptionGroup>();
  const add = (kind: RelationKind, direction: "out" | "in", other: typeof all[number], label: string) => {
    const key = `${direction}|${kind}`;
    const group = groups.get(key) ?? { label, options: [] };
    group.options.push({
      value: `${direction}|${kind}|${other.id}`,
      label: `${other.name} (${CI_TYPES[other.type].label})`,
    });
    groups.set(key, group);
  };
  for (const kind of Object.keys(RELATION_KINDS) as RelationKind[]) {
    const def = RELATION_KINDS[kind];
    for (const [from, to] of def.rules as readonly (readonly [CIType, CIType])[]) {
      for (const other of all) {
        if (other.id === self.id) continue;
        if (self.type === from && other.type === to) {
          add(kind, "out", other, `${self.name} ${def.label} …`);
        }
        if (self.type === to && from !== to && other.type === from) {
          add(kind, "in", other, `… ${def.label} ${self.name} (${def.inverse})`);
        }
      }
    }
  }
  return [...groups.values()];
}

function parseName(formData: FormData): string | { error: string } {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Name ist erforderlich." };
  if (name.length > 200) return { error: "Name ist zu lang (max. 200 Zeichen)." };
  return name;
}

function errorMessage(error: unknown): string {
  if (error instanceof ModelError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export async function createCIAction(
  type: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!isCIType(type)) return { error: "Ungültiger Typ." };
  const name = parseName(formData);
  if (typeof name !== "string") return name;
  const parsed = parseFields(fieldsFor(type), formData);
  if ("error" in parsed) return parsed;
  if (parsed.values.status == null) return { error: "Status ist erforderlich." };

  let id: string;
  try {
    id = await createCI(type, name, parsed.values);
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath("/");
  redirect(`/ci/${id}`);
}

export async function updateCIAction(
  id: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const ci = await getCI(id);
    if (!ci) return { error: "CI nicht gefunden." };
    const name = parseName(formData);
    if (typeof name !== "string") return name;
    const parsed = parseFields(fieldsFor(ci.type), formData);
    if ("error" in parsed) return parsed;
    if (parsed.values.status == null) return { error: "Status ist erforderlich." };
    await updateCI(ci, name, parsed.values);
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath("/");
  revalidatePath(`/ci/${id}`);
  return undefined;
}

export async function deleteCIAction(id: string): Promise<FormState> {
  if (!isValidId(id)) return { error: "Ungültige ID." };
  try {
    await deleteCI(id);
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath("/");
  redirect("/");
}

export async function addRelationAction(
  selfId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const [direction, kind, otherId] = String(formData.get("target") ?? "").split("|");
  if (
    !isValidId(selfId) ||
    (direction !== "out" && direction !== "in") ||
    !isRelationKind(kind) ||
    !isValidId(otherId ?? "")
  ) {
    return { error: "Bitte eine Beziehung auswählen." };
  }

  const defs = RELATION_KINDS[kind].fields.map((name) => RELATION_FIELDS[name]);
  const parsed = parseFields(defs, formData);
  if ("error" in parsed) return parsed;
  const attrs = Object.fromEntries(
    Object.entries(parsed.values).map(([key, value]) => [key, value ?? undefined]),
  ) as Record<string, string | number | undefined>;

  try {
    await addRelation({
      fromId: direction === "out" ? selfId : otherId,
      toId: direction === "out" ? otherId : selfId,
      kind,
      attrs,
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath(`/ci/${selfId}`);
  revalidatePath(`/ci/${otherId}`);
  return undefined;
}

export async function removeRelationAction(
  relationId: string,
  ciId: string,
): Promise<void> {
  if (!isValidId(relationId) || !isValidId(ciId)) return;
  await removeRelation(relationId);
  revalidatePath(`/ci/${ciId}`);
}
