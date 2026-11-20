"use client";

/** Proste elementy formularzy i przycisków aplikacji (Tailwind, kolory z `globals.css`). */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

type Kind = "primary" | "secondary" | "ghost" | "danger";

const BUTTON: Record<Kind, string> = {
  primary: "bg-[var(--accent)] text-white hover:opacity-90",
  secondary: "border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--hover)]",
  ghost: "hover:bg-[var(--hover)]",
  danger: "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950",
};

export function Button({ kind = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: Kind }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON[kind]} ${className}`}
    />
  );
}

/** Mały przycisk z ikoną-znakiem (strzałki kolejności itp.). */
export function IconButton({ label, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={`inline-flex h-7 w-7 items-center justify-center rounded text-sm opacity-70 hover:bg-[var(--hover)] hover:opacity-100 disabled:opacity-25 ${className}`}
    />
  );
}

/** Link przejścia / powrotu („← Nawyki”, „Przegląd tygodnia →”) — jeden styl z ramką, dla `<a>` i `<button>`. */
export const navLinkClass =
  "inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2.5 py-1 text-xs font-medium text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)]";

export const inputClass =
  "min-w-0 rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs opacity-60">{hint}</span> : null}
    </label>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4 ${className}`}>{children}</section>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "ok"; children: ReactNode }) {
  const color =
    tone === "error"
      ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
      : tone === "ok"
        ? "border-green-300 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200"
        : "border-[var(--line)] bg-[var(--surface)]";
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${color}`}>
      {children}
    </p>
  );
}

export function Splash({ text }: { text: string }) {
  return (
    <main className="flex flex-1 items-center justify-center p-8 text-sm opacity-70" aria-busy="true">
      {text}
    </main>
  );
}
