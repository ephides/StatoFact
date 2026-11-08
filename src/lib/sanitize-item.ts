import { ModelError, type Value } from "@/lib/cmdb";
import { fieldsFor, isCIType, type CIType } from "@/lib/model";

export function sanitizeItem(item: unknown): { type: CIType; name: string; values: Record<string, Value> } {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new ModelError("Eintrag ist kein Objekt.");
  }
  const raw = item as Record<string, unknown>;
  const type = String(raw.type ?? "");
  if (!isCIType(type)) throw new ModelError(`Unbekannter Typ "${type}".`);
  const name = String(raw.name ?? "").trim();
  if (!name || name.length > 200) throw new ModelError("Name fehlt oder ist zu lang.");
  const values: Record<string, Value> = {};
  for (const def of fieldsFor(type)) {
    const value = raw[def.name];
    if (value === undefined || value === null || value === "") continue;
    if (def.kind === "number") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new ModelError(`${def.name}: ganze Zahl erforderlich.`);
      }
      if ((def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max)) {
        throw new ModelError(`${def.name}: außerhalb des zulässigen Bereichs.`);
      }
      values[def.name] = value;
    } else {
      const text = String(value);
      if (def.kind === "select" && !def.options?.includes(text)) {
        throw new ModelError(`${def.name}: ungültiger Wert "${text}".`);
      }
      if (text.length > (def.kind === "textarea" ? 5000 : 200)) {
        throw new ModelError(`${def.name}: zu lang.`);
      }
      values[def.name] = text;
    }
  }
  return { type, name, values };
}
