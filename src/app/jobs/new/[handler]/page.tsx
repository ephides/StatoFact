import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActionForm } from "@/app/action-form";
import { FieldInput } from "@/app/ci-fields";
import { createJobAction } from "@/app/jobs/actions";
import { HANDLERS, isHandler } from "@/lib/jobs/handlers";

async function NewJob({ params }: { params: Promise<{ handler: string }> }) {
  const { handler } = await params;
  if (!isHandler(handler)) notFound();
  const def = HANDLERS[handler];

  return (
    <>
      <p>
        <Link href="/jobs">← Zurück zu den Jobs</Link>
      </p>
      <h1>Neu: {def.label}</h1>
      <p className="muted">{def.description}</p>
      <section>
        <ActionForm action={createJobAction.bind(null, handler)} submitLabel="Anlegen">
          <label>
            Name
            <input name="name" required maxLength={200} />
          </label>
          {def.fields.map((field) => (
            <FieldInput key={field.name} def={field} value={field.defaultValue} />
          ))}
          <label>
            Zeitplan
            <select name="scheduleType" defaultValue="interval">
              <option value="interval">Regelmäßig (Intervall)</option>
              <option value="once">Einmalig</option>
            </select>
          </label>
          <label>
            Intervall (Minuten, nur bei regelmäßig)
            <input name="intervalMinutes" type="number" min={1} max={10080} defaultValue={60} />
          </label>
          <label>
            Start (leer = sofort, Ortszeit des Servers)
            <input name="runAt" type="datetime-local" />
          </label>
        </ActionForm>
      </section>
    </>
  );
}

export default function NewJobPage({ params }: PageProps<"/jobs/new/[handler]">) {
  return (
    <Suspense fallback={<p className="muted">Lade…</p>}>
      <NewJob params={params} />
    </Suspense>
  );
}
