"use client";

/**
 * Zwijana sekcja Ustawień; stan per urządzenie w `localStorage`. Treść montuje się przy pierwszym rozwinięciu
 * (zwinięta nic nie pobiera), a zwinięcie tylko ją ukrywa — niezapisane pola formularza zostają.
 */
import { useState, type ReactNode } from "react";

import { Card } from "./ui";

const storageKey = (id: string) => `tp-settings-open-${id}`;

const readOpen = (id: string, fallback: boolean): boolean => {
  try {
    const value = window.localStorage.getItem(storageKey(id));
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
};

const writeOpen = (id: string, open: boolean) => {
  try {
    window.localStorage.setItem(storageKey(id), open ? "1" : "0");
  } catch {
    // Bez pamięci przeglądarki — stan tylko do przeładowania.
  }
};

/** Sekcja rozwinięta przy najbliższym wejściu w Ustawienia (np. powrót ze zgody Google). */
export const openSettingsSection = (id: string) => writeOpen(id, true);

export function CollapsibleCard({
  id,
  title,
  defaultOpen = false,
  alert = false,
  className = "mt-4",
  children,
}: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  /** Sekcja wymaga działania (np. odwołany dostęp) — znacznik przy tytule, widoczny też po zwinięciu. */
  alert?: boolean;
  className?: string;
  children: ReactNode;
}) {
  // Ustawienia renderują się dopiero po zalogowaniu (nie na serwerze), więc stan można czytać od razu.
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const [mounted, setMounted] = useState(open);
  const toggle = () => {
    setOpen(!open);
    setMounted(true);
    writeOpen(id, !open);
  };
  const body = `settings-${id}`;
  return (
    <Card className={className}>
      <h2 className="text-sm font-semibold">
        <button type="button" aria-expanded={open} aria-controls={mounted ? body : undefined} onClick={toggle} className="flex w-full items-center gap-2 text-left">
          <span aria-hidden className={`inline-block w-3 text-[var(--muted)] transition-transform ${open ? "rotate-90" : ""}`}>
            ▸
          </span>
          {title}
          {alert ? <span className="text-xs font-normal text-[var(--danger)]">wymaga uwagi</span> : null}
        </button>
      </h2>
      {mounted ? (
        <div id={body} hidden={!open} className="mt-3">
          {children}
        </div>
      ) : null}
    </Card>
  );
}
