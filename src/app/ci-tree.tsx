"use client";

import { Suspense } from "react";
import { CIGroup } from "@/app/ci-group";
import { NAVIGABLE_CI_TYPES } from "@/lib/model";

export function CITree() {
  return (
    <Suspense fallback={<p className="muted">Navigation wird geladen…</p>}>
      <nav className="ci-tree" aria-label="Configuration Items">
        {NAVIGABLE_CI_TYPES.map((type) => <CIGroup key={type} type={type} variant="tree" />)}
      </nav>
    </Suspense>
  );
}
