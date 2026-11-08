import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";
import { ActionForm } from "@/app/action-form";
import { AutoRefresh } from "@/app/jobs/auto-refresh";
import { deleteJobAction, runJobAction, toggleJobAction } from "@/app/jobs/actions";
import { STATUS_LABELS, describeSchedule, formatTime } from "@/app/jobs/format";
import { HANDLERS } from "@/lib/jobs/handlers";
import { getJob, listRuns } from "@/lib/jobs/store";

async function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const id = decodeURIComponent((await params).id);
  const job = await getJob(id);
  if (!job) notFound();
  const runs = await listRuns(id);
  const handler = HANDLERS[job.handler];

  return (
    <>
      <AutoRefresh />
      <p>
        <Link href="/jobs">← Zurück zu den Jobs</Link>
      </p>
      <h1>
        {job.name} {!job.enabled && <span className="badge">pausiert</span>}
      </h1>
      <section>
        <table>
          <tbody>
            <tr>
              <th>Typ</th>
              <td>{handler?.label ?? `${job.handler} (unbekannt)`}</td>
            </tr>
            <tr>
              <th>Zeitplan</th>
              <td>{describeSchedule(job)}</td>
            </tr>
            <tr>
              <th>Nächster Lauf</th>
              <td>
                {job.enabled ? formatTime(job.nextRunAt) : "–"}
                {job.runRequested && " (manueller Lauf angefordert)"}
              </td>
            </tr>
            {handler?.fields.map((field) => (
              <tr key={field.name}>
                <th>{field.label}</th>
                <td>{job.params[field.name] ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="chips">
          <form action={runJobAction.bind(null, id)}>
            <button type="submit">Jetzt ausführen</button>
          </form>
          <form action={toggleJobAction.bind(null, id, !job.enabled)}>
            <button type="submit">{job.enabled ? "Pausieren" : "Aktivieren"}</button>
          </form>
        </div>
      </section>
      <section>
        <h2>Letzte Läufe</h2>
        {runs.length === 0 && <p className="muted">Noch keine Läufe.</p>}
        {runs.map((run) => (
          <details key={run.id} className="run">
            <summary>
              {formatTime(run.startedAt)}{" "}
              <span className={`badge status-${run.status}`}>{STATUS_LABELS[run.status]}</span>
              {run.finishedAt !== undefined && (
                <span className="muted"> ({((run.finishedAt - run.startedAt) / 1000).toFixed(1)} s)</span>
              )}
            </summary>
            <pre>{run.log || "(kein Protokoll)"}</pre>
          </details>
        ))}
      </section>
      <section>
        <ActionForm action={deleteJobAction.bind(null, id)} submitLabel="Job löschen" danger />
      </section>
    </>
  );
}

export default function JobPage({ params }: PageProps<"/jobs/[id]">) {
  return (
    <Suspense fallback={<p className="muted">Lade…</p>}>
      <JobDetail params={params} />
    </Suspense>
  );
}
