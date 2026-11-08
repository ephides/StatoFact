import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { CI_TYPES, NAVIGABLE_CI_TYPES, isCIType } from "@/lib/model";
import { CIIcon } from "@/app/ci-icon";
import { CIGroup } from "@/app/ci-group";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

async function CIList({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const params = await searchParams;
  const q = first(params.q).trim();
  const requestedType = first(params.type);
  const type = isCIType(requestedType) && requestedType !== "SoftwarePackage" ? requestedType : "";
  const types = type ? [type] : NAVIGABLE_CI_TYPES;

  return (
    <>
      <form className="inline" method="get">
        <label>
          Suche
          <input name="q" defaultValue={q} maxLength={200} placeholder="Name…" />
        </label>
        <label>
          Typ
          <select name="type" defaultValue={type}>
            <option value="">Alle</option>
            {NAVIGABLE_CI_TYPES.map((t) => (
              <option key={t} value={t}>
                {CI_TYPES[t].label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Filtern</button>
      </form>
      {q.length > 200 ? <p className="error">Der Suchbegriff darf höchstens 200 Zeichen lang sein.</p> : (
        <div className="ci-list-groups">
          {types.map((ciType) => <CIGroup key={`${ciType}|${q}`} type={ciType} search={q} />)}
        </div>
      )}
    </>
  );
}

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <>
      <h1>Configuration Items</h1>
      <section>
        <h2>Neu anlegen</h2>
        <div className="chips">
          {NAVIGABLE_CI_TYPES.map((t) => (
            <Link key={t} href={`/new/${t}`} className="chip">
              <CIIcon type={t} />{CI_TYPES[t].label}
            </Link>
          ))}
        </div>
      </section>
      <section>
        <Suspense fallback={<p className="muted">Lade…</p>}>
          <CIList searchParams={searchParams} />
        </Suspense>
      </section>
    </>
  );
}
