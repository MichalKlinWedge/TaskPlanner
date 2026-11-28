"use client";

/**
 * Okno wyboru z kilkoma przyciskami (np. „Z podzadaniami” / „Tylko to” / „Anuluj”) — tam, gdzie
 * `window.confirm` ma za mało odpowiedzi. Wywołanie obietnicą: `chooseOption(…)` → wybrana wartość
 * albo `null` (Anuluj, Esc, klik w tło). Fokus zostaje w oknie (Tab krąży po przyciskach) i wraca
 * po zamknięciu do elementu, który był aktywny; klawisze nie docierają do skrótów aplikacji.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";

export interface ChoiceOption<T extends string> {
  label: string;
  value: T;
  tone?: "primary" | "danger";
}

interface ChoiceProps<T extends string> {
  title: string;
  message?: string;
  options: readonly ChoiceOption<T>[];
  cancelLabel: string;
  onDone: (value: T | null) => void;
}

function ChoiceDialog<T extends string>({ title, message, options, cancelLabel, onDone }: ChoiceProps<T>) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("button[data-first]")?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onDone(null);
    } else if (e.key === "Tab") {
      const buttons = [...(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = (at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      e.preventDefault();
      buttons[next]?.focus();
    }
  };

  const tone = (t?: "primary" | "danger") =>
    t === "danger"
      ? "border-transparent bg-[var(--danger)] text-white hover:opacity-90"
      : t === "primary"
        ? "border-transparent bg-[var(--accent)] text-white hover:opacity-90"
        : "border-[var(--line)] hover:bg-[var(--hover)]";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onDone(null)}>
      <div
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tp-choice-title"
        aria-describedby={message ? "tp-choice-message" : undefined}
        onKeyDown={onKeyDown}
        className="w-full max-w-sm rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-2xl"
      >
        <h2 id="tp-choice-title" className="text-base font-semibold">
          {title}
        </h2>
        {message ? (
          <p id="tp-choice-message" className="mt-1 text-sm text-[var(--muted)]">
            {message}
          </p>
        ) : null}
        <div className="mt-4 flex flex-col gap-2">
          {options.map((o, i) => (
            <button key={o.value} type="button" data-first={i === 0 ? "" : undefined} className={`rounded-md border px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:outline-none ${tone(o.tone)}`} onClick={() => onDone(o.value)}>
              {o.label}
            </button>
          ))}
          <button type="button" className="rounded-md px-3 py-2 text-sm text-[var(--muted)] hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none" onClick={() => onDone(null)}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function chooseOption<T extends string>({ title, message, options, cancelLabel = "Anuluj" }: { title: string; message?: string; options: readonly ChoiceOption<T>[]; cancelLabel?: string }): Promise<T | null> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return new Promise((resolve) => {
    const done = (value: T | null) => {
      // Odmontowanie poza obsługą zdarzenia tego samego korzenia (React ostrzega przy synchronicznym).
      setTimeout(() => {
        root.unmount();
        host.remove();
      }, 0);
      before?.focus();
      resolve(value);
    };
    root.render(<ChoiceDialog title={title} message={message} options={options} cancelLabel={cancelLabel} onDone={done} />);
  });
}
