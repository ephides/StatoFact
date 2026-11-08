import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActionForm } from "@/app/action-form";
import { createCIAction } from "@/app/actions";
import { CIFields } from "@/app/ci-fields";
import { CI_TYPES, isCIType } from "@/lib/model";
import { CIIcon } from "@/app/ci-icon";

async function NewCI({ params }: { params: Promise<{ type: string }> }) {
  const { type } = await params;
  if (!isCIType(type)) notFound();

  return (
    <>
      <p>
        <Link href="/">← Zurück zur Liste</Link>
      </p>
      <h1>Neu: <CIIcon type={type} />{CI_TYPES[type].label}</h1>
      <section>
        <ActionForm action={createCIAction.bind(null, type)} submitLabel="Anlegen">
          <CIFields type={type} />
        </ActionForm>
      </section>
    </>
  );
}

export default function NewCIPage({ params }: PageProps<"/new/[type]">) {
  return (
    <Suspense fallback={<p className="muted">Lade…</p>}>
      <NewCI params={params} />
    </Suspense>
  );
}
