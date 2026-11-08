"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import { getCIPageAction } from "@/app/actions";
import { CIIcon } from "@/app/ci-icon";
import type { CIPageItem } from "@/lib/cmdb";
import { CI_TYPES, type CIType } from "@/lib/model";

export function CIGroup({ type, search = "", variant = "list" }: {
  type: CIType;
  search?: string;
  variant?: "tree" | "list";
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: CIPageItem[]; hasNext: boolean }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const requestedPage = useRef(1);

  async function load(nextPage: number) {
    const current = ++request.current;
    requestedPage.current = nextPage;
    setLoading(true);
    setError("");
    try {
      const result = await getCIPageAction(type, nextPage, search);
      if (request.current !== current) return;
      setPage(nextPage);
      setData(result);
    } catch (reason) {
      if (request.current !== current) return;
      setError(reason instanceof Error ? reason.message : "CIs konnten nicht geladen werden.");
    } finally {
      if (request.current === current) setLoading(false);
    }
  }

  function toggle() {
    if (open) {
      request.current++;
      setOpen(false);
      setLoading(false);
      return;
    }
    setOpen(true);
    void load(1);
  }

  const tree = variant === "tree";
  return (
    <div className={tree ? "ci-tree-group" : "ci-list-group"}>
      <button type="button" className="ci-group-toggle" aria-expanded={open} onClick={toggle}>
        <span><span className="ci-group-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span><CIIcon type={type} />{CI_TYPES[type].plural}</span>
      </button>
      {open && (
        <div className={tree ? "ci-tree-contents" : "ci-list-contents"}>
          {loading && <p className="muted" role="status">Lade CIs…</p>}
          {error && <p className="error" role="alert">{error} <button type="button" className="ci-text-button" onClick={() => void load(requestedPage.current)}>Erneut versuchen</button></p>}
          {!loading && !error && data && (
            <>
              {data.items.length === 0 ? <p className="muted">Keine Configuration Items gefunden.</p> : tree ? (
                <ul>
                  {data.items.map((ci) => {
                    const href = `/ci/${ci.id}`;
                    const selected = pathname === href;
                    return <li key={ci.id}><Link href={href} prefetch={false} className={selected ? "ci-tree-item selected" : "ci-tree-item"} aria-current={selected ? "page" : undefined} title={`${ci.name} (${CI_TYPES[type].label})`}><CIIcon type={type} />{ci.name}</Link></li>;
                  })}
                </ul>
              ) : (
                <table>
                  <thead><tr><th>Name</th><th>Status</th><th>Verantwortlich</th></tr></thead>
                  <tbody>{data.items.map((ci) => (
                    <tr key={ci.id}>
                      <td><Link href={`/ci/${ci.id}`} prefetch={false}><CIIcon type={type} />{ci.name}</Link></td>
                      <td><span className="badge">{ci.status}</span></td>
                      <td>{ci.owner}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              {(page > 1 || data.hasNext) && (
                <div className="ci-pagination" aria-label={`Seiten ${CI_TYPES[type].plural}`}>
                  <button type="button" disabled={page === 1} onClick={() => void load(page - 1)}>Zurück</button>
                  <span>Seite {page}</span>
                  <button type="button" disabled={!data.hasNext} onClick={() => void load(page + 1)}>Weiter</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
