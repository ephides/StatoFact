import type { FieldDef } from "@/lib/model";

export type FieldValue = string | number | null;
export type Parsed = { values: Record<string, FieldValue> } | { error: string };

// Prüft Formularwerte gegen Feld-Definitionen; leere Eingaben werden zu null.
export function parseFields(defs: readonly FieldDef[], formData: FormData): Parsed {
  const values: Record<string, FieldValue> = {};
  for (const def of defs) {
    const raw = String(formData.get(def.name) ?? "").trim();
    if (raw === "") {
      values[def.name] = null;
      continue;
    }
    if (def.kind === "number") {
      const n = Number(raw);
      if (!Number.isInteger(n)) return { error: `${def.label}: ganze Zahl erforderlich.` };
      if (def.min !== undefined && n < def.min) {
        return { error: `${def.label}: mindestens ${def.min}.` };
      }
      if (def.max !== undefined && n > def.max) {
        return { error: `${def.label}: höchstens ${def.max}.` };
      }
      values[def.name] = n;
    } else if (def.kind === "select") {
      if (!def.options?.includes(raw)) return { error: `${def.label}: ungültiger Wert.` };
      values[def.name] = raw;
    } else {
      const max = def.kind === "textarea" ? 5000 : 200;
      if (raw.length > max) return { error: `${def.label}: zu lang (max. ${max} Zeichen).` };
      values[def.name] = raw;
    }
  }
  return { values };
}
