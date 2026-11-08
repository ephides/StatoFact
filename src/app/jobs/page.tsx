import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { AutoRefresh } from "@/app/jobs/auto-refresh";
import { STATUS_LABELS, describeSchedule, formatTime } from "@/app/jobs/format";
import { HANDLERS } from "@/lib/jobs/handlers";
import { listJobs } from "@/lib/jobs/store";

async function JobList() {
  await connection();
  let jobs;
  try {
    jobs = await listJobs();
  } catch (error) {
    return <p className="error">{error instanceof Error ? error.message : "Datenbankfehler"}</p>;
  }

  return (
    <>
      <AutoRefresh />
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Typ</th>
            <th>Zeitplan</th>
            <th>Nächster Lauf</th>
            <th>Letzter Lauf</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <Link href={`/jobs/${job.id}`}>{job.name}</Link>
                {!job.enabled && <span className="badge"> pausiert</span>}
              </td>
              <td>{HANDLERS[job.handler]?.label ?? job.handler}</td>
              <td>{describeSchedule(job)}</td>
              <td>{job.enabled ? formatTime(job.nextRunAt) : "–"}</td>
              <td>
                {formatTime(job.lastRunAt)}{" "}
                {job.lastStatus && (
                  <span className={`badge status-${job.lastStatus}`}>
                    {STATUS_LABELS[job.lastStatus]}
                  </span>
                )}
              </td>
            </tr>
          ))}
          {jobs.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Noch keine Jobs angelegt.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

export default function JobsPage() {
  return (
    <>
      <h1>Jobs</h1>
      <section>
        <h2>Neu anlegen</h2>
        <div className="chips">
          {Object.entries(HANDLERS).map(([key, handler]) => (
            <Link key={key} href={`/jobs/new/${key}`} className="chip">
              + {handler.label}
            </Link>
          ))}
        </div>
      </section>
      <section>
        <Suspense fallback={<p className="muted">Lade…</p>}>
          <JobList />
        </Suspense>
      </section>
    </>
  );
}
