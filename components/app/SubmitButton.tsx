// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import { useFormStatus } from "react-dom";

export function SubmitButton({ children, pending: pendingLabel, className = "btn", ...rest }: { children: React.ReactNode; pending?: string; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-disabled={pending} {...rest}>
      {pending && <span className="spin" aria-hidden="true" />}
      {pending ? (pendingLabel ?? "Working…") : children}
    </button>
  );
}
