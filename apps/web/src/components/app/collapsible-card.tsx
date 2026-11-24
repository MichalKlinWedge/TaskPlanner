"use client";

/** Zwijana karta Ustawień: domyślnie zwinięta, stan per urządzenie w `localStorage`; zwinięta nie montuje treści. */
import { useState, type ReactNode } from "react";

import { Card } from "./ui";

const storageKey = (id: string) => `tp-settings-open-${id}`;

const readOpen = (id: string): boolean => {
  try {
    return window.localStorage.getItem(storageKey(id)) === "1";
  } catch {
    return false;
  }
};

export function CollapsibleCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  // Ustawienia renderują się dopiero po zalogowaniu (nie na serwerze), więc stan można czytać od razu.
  const [open, setOpen] = useState(() => readOpen(id));
  const toggle = () => {
    setOpen(!open);
    try {
      if (open) window.localStorage.removeItem(storageKey(id));
      else window.localStorage.setItem(storageKey(id), "1");
    } catch {
      // Bez pamięci przeglądarki — stan tylko do przeładowania.
    }
  };
  const body = `settings-${id}`;
  return (
    <Card className="mt-4">
      <h2 className="text-sm font-semibold">
        <button type="button" aria-expanded={open} aria-controls={open ? body : undefined} onClick={toggle} className="flex w-full items-center gap-2 text-left">
          <span aria-hidden className={`inline-block w-3 text-[var(--muted)] transition-transform ${open ? "rotate-90" : ""}`}>
            ▸
          </span>
          {title}
        </button>
      </h2>
      {open ? (
        <div id={body} className="mt-2">
          {children}
        </div>
      ) : null}
    </Card>
  );
}
