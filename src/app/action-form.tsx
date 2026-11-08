"use client";

import { useActionState, type ReactNode } from "react";
import type { FormState } from "@/app/actions";

export function ActionForm({
  action,
  submitLabel,
  danger,
  children,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  submitLabel: string;
  danger?: boolean;
  children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction}>
      {children}
      {state?.error && <p className="error">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className={danger ? "danger" : undefined}
      >
        {pending ? "…" : submitLabel}
      </button>
    </form>
  );
}
