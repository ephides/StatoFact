"use client";

import { useState } from "react";
import { ActionForm } from "@/app/action-form";
import { addRelationAction, getRelationOptionsAction, type RelationOptionGroup } from "@/app/actions";
import { FieldInput } from "@/app/ci-fields";
import { RELATION_FIELDS } from "@/lib/model";

export function RelationEditor({ ciId }: { ciId: string }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<RelationOptionGroup[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    setError("");
    try {
      setGroups(await getRelationOptionsAction(ciId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Beziehungsziele konnten nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button type="button" onClick={toggle} aria-expanded={open}>
        {open ? "Beziehung hinzufügen schließen" : "Beziehung hinzufügen"}
      </button>
      {open && (
        <div className="relation-editor">
          {loading && <p className="muted">Lade Beziehungsziele…</p>}
          {error && <p className="error">{error}</p>}
          {!loading && !error && groups && (groups.length === 0 ? (
            <p className="muted">Für diesen Typ gibt es aktuell keine passenden Ziel-CIs.</p>
          ) : (
            <ActionForm action={addRelationAction.bind(null, ciId)} submitLabel="Hinzufügen">
              <label>
                Beziehung
                <select name="target" required defaultValue="">
                  <option value="" disabled>Auswählen…</option>
                  {groups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.options.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <details>
                <summary>Optionale Angaben (HE, Strang, Ports, IP)</summary>
                <div className="rel-fields">
                  {Object.values(RELATION_FIELDS).map((def) => <FieldInput key={def.name} def={def} />)}
                </div>
                <p className="muted">Für Geräte in Racks ist die unterste HE erforderlich. Nicht passende Angaben werden ignoriert.</p>
              </details>
            </ActionForm>
          ))}
        </div>
      )}
    </>
  );
}
