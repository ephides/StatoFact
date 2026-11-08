import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";
import { ActionForm } from "@/app/action-form";
import {
  deleteCIAction,
  removeRelationAction,
  updateCIAction,
} from "@/app/actions";
import { CIFields } from "@/app/ci-fields";
import { RelationEditor } from "@/app/relation-editor";
import { CIIcon } from "@/app/ci-icon";
import {
  getCI,
  listRelations,
  listSoftwareInstallations,
  locationPath,
  type CI,
  type RelationEntry,
} from "@/lib/cmdb";
import {
  CI_TYPES,
  RELATION_FIELDS,
  RELATION_KINDS,
} from "@/lib/model";

function describeAttrs(attrs: RelationEntry["attrs"]): string {
  return Object.entries(attrs)
    .map(([key, value]) => `${RELATION_FIELDS[key]?.label ?? key}: ${value}`)
    .join(", ");
}

function RelationTable({
  entries,
  ciId,
}: {
  entries: RelationEntry[];
  ciId: string;
}) {
  if (entries.length === 0) return <p className="muted">Keine Beziehungen.</p>;
  return (
    <table>
      <tbody>
        {entries.map((r) => {
          const def = RELATION_KINDS[r.kind];
          return (
            <tr key={r.id}>
              <td>
                <span className="badge">
                  {r.direction === "out" ? def.label : def.inverse}
                </span>
              </td>
              <td>
                <Link href={`/ci/${r.otherId}`} prefetch={false}><CIIcon type={r.otherType} />{r.otherName}</Link>{" "}
                <span className="muted">({CI_TYPES[r.otherType].label})</span>
              </td>
              <td className="muted">{describeAttrs(r.attrs)}</td>
              <td>
                <form action={removeRelationAction.bind(null, r.id, ciId)}>
                  <button type="submit" className="link">
                    Entfernen
                  </button>
                </form>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function rackUsage(ci: CI, entries: RelationEntry[]) {
  const total = Number(ci.values.heightU ?? 42);
  const used = entries
    .filter(
      (e) =>
        e.direction === "in" && e.kind === "located_in" && e.attrs.rackUnit !== undefined,
    )
    .reduce((sum, e) => sum + (e.otherHeightU ?? 1), 0);
  return { total, used };
}

async function CIDetail({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const id = decodeURIComponent((await params).id);
  const ci = await getCI(id);
  if (!ci) notFound();

  const [entries, path, installations] = await Promise.all([
    listRelations(id),
    locationPath(id),
    ci.type === "Software" ? listSoftwareInstallations(id) : Promise.resolve([]),
  ]);
  const usage = ci.type === "Rack" ? rackUsage(ci, entries) : null;

  return (
    <>
      <p>
        <Link href="/">← Zurück zur Liste</Link>
      </p>
      <h1>
        <CIIcon type={ci.type} />{ci.name} <span className="badge">{CI_TYPES[ci.type].label}</span>
      </h1>
      {path.length > 0 && (
        <p className="crumbs">
          {path.map((p, i) => (
            <span key={p.id}>
              {i > 0 && " › "}
              <Link href={`/ci/${p.id}`}><CIIcon type={p.type} />{p.name}</Link>
            </span>
          ))}
        </p>
      )}
      {usage && (
        <p>
          Belegung: <strong>{usage.used}</strong> von {usage.total} HE
        </p>
      )}
      <section>
        <h2>Details</h2>
        <ActionForm action={updateCIAction.bind(null, id)} submitLabel="Speichern">
          <CIFields type={ci.type} name={ci.name} values={ci.values} />
        </ActionForm>
      </section>
      <section>
        {ci.type === "Software" && (
          <>
            <h2>Installiert auf</h2>
            {installations.length === 0 ? <p className="muted">Keine Installationen vorhanden.</p> : (
              <table>
                <thead><tr><th>System</th><th>Version</th><th>Architektur</th><th>Installation</th><th>Beziehung</th></tr></thead>
                <tbody>
                  {installations.map((installation) => (
                    <tr key={installation.relationId}>
                      <td>
                        {installation.hosts.length === 0 ? <span className="muted">Kein System zugeordnet</span> : installation.hosts.map((host, index) => (
                          <span key={host.id}>{index > 0 && ", "}<Link href={`/ci/${host.id}`} prefetch={false}><CIIcon type={host.type} />{host.name}</Link></span>
                        ))}
                      </td>
                      <td>{installation.version || "–"}</td>
                      <td>{installation.architecture || "–"}</td>
                      <td><Link href={`/ci/${installation.id}`} prefetch={false}><CIIcon type="SoftwarePackage" />{installation.name}</Link></td>
                      <td>
                        <form action={removeRelationAction.bind(null, installation.relationId, id)}>
                          <button type="submit" className="link">Entfernen</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        <h2>Beziehungen</h2>
        <RelationTable entries={ci.type === "Software"
          ? entries.filter((entry) => entry.kind !== "installation_of" || entry.direction !== "in")
          : entries} ciId={id} />
        <RelationEditor key={id} ciId={id} />
      </section>
      <section>
        <ActionForm
          action={deleteCIAction.bind(null, id)}
          submitLabel="CI löschen"
          danger
        />
      </section>
    </>
  );
}

export default function CIPage({ params }: PageProps<"/ci/[id]">) {
  return (
    <Suspense fallback={<p className="muted">Lade…</p>}>
      <CIDetail params={params} />
    </Suspense>
  );
}
