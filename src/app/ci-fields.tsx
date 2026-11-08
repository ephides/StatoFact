import { fieldsFor, type CIType, type FieldDef } from "@/lib/model";
import type { Value } from "@/lib/cmdb";

export function FieldInput({
  def,
  value,
}: {
  def: FieldDef;
  value?: Value;
}) {
  const current = value ?? undefined;
  return (
    <label>
      {def.label}
      {def.kind === "select" ? (
        <select name={def.name} defaultValue={current === undefined ? "" : String(current)}>
          {def.name !== "status" && <option value="">–</option>}
          {def.options?.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : def.kind === "textarea" ? (
        <textarea name={def.name} rows={3} defaultValue={current as string | undefined} />
      ) : def.kind === "number" ? (
        <input
          name={def.name}
          type="number"
          step={1}
          min={def.min}
          max={def.max}
          defaultValue={current}
        />
      ) : (
        <input name={def.name} maxLength={200} defaultValue={current as string | undefined} />
      )}
    </label>
  );
}

export function CIFields({
  type,
  name,
  values,
}: {
  type: CIType;
  name?: string;
  values?: Record<string, Value>;
}) {
  return (
    <>
      <label>
        Name
        <input name="name" required maxLength={200} defaultValue={name} />
      </label>
      {fieldsFor(type).map((def) => (
        <FieldInput
          key={def.name}
          def={def}
          value={values ? values[def.name] : def.defaultValue}
        />
      ))}
    </>
  );
}
