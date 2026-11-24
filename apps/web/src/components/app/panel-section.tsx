"use client";

/**
 * Sekcja panelu zadania: karta z tłem i nagłówkiem, który ją zwija / rozwija. Stan zwinięcia jest
 * w ustawieniach profilu (`settings.taskPanel.collapsed`, synchronizowany jak reszta profilu), więc
 * zostaje dla użytkownika między zadaniami, kartami i urządzeniami. Zwinięta sekcja nie renderuje
 * treści (np. historia nie pobiera się, dopóki jej nie rozwiniesz).
 */
import { TASK_SECTION_ICON } from "@taskplanner/core";
import { createContext, useContext, type HTMLAttributes, type ReactNode } from "react";

import { useAppEnv } from "./app-env";
import { useTaskActions } from "./task-item";

/**
 * Sekcje tylko do odczytu (przestrzeń / lista do podglądu, zadanie w koszu): `fieldset disabled` obejmuje treść
 * sekcji, a nie nagłówek — zwiniętą sekcję da się rozwinąć także w podglądzie.
 */
const LockedContext = createContext(false);
export const LockedSections = LockedContext.Provider;
export const useSectionsLocked = () => useContext(LockedContext);

/** Czy sekcja jest zwinięta + przełącznik (zapis do profilu). */
export function useSectionCollapsed(id: string, defaultCollapsed = false): [boolean, () => void] {
  const { store, userId, settings } = useAppEnv();
  const { notify } = useTaskActions();
  const collapsed = settings.taskPanel.collapsed[id] ?? defaultCollapsed;
  const toggle = () => {
    const next = { ...settings.taskPanel.collapsed, [id]: !collapsed };
    // Wartość równa domyślnej nie musi być zapisana — profil nie rośnie od samego klikania.
    if (next[id] === defaultCollapsed) delete next[id];
    void store.mutate("profiles", userId, { settings: { ...settings, taskPanel: { ...settings.taskPanel, collapsed: next } } }).catch((e: unknown) => notify(String(e)));
  };
  return [collapsed, toggle];
}

export function PanelSection({
  id,
  title,
  count,
  actions,
  defaultCollapsed = false,
  className = "",
  children,
  ...rest
}: {
  /** Stały klucz sekcji (zapis stanu zwinięcia). */
  id: string;
  title: string;
  /** Liczba / postęp obok tytułu (widoczna też po zwinięciu). */
  count?: ReactNode;
  /** Przyciski po prawej stronie nagłówka (działają też przy zwiniętej sekcji). */
  actions?: ReactNode;
  defaultCollapsed?: boolean;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "title">) {
  const [collapsed, toggle] = useSectionCollapsed(id, defaultCollapsed);
  const locked = useSectionsLocked();
  const bodyId = `panel-section-${id}`;
  return (
    <section className={`mt-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] shadow-sm ${className}`} aria-label={title} data-section={id} {...rest}>
      <div className={`flex min-h-10 items-center gap-2 bg-[var(--hover)]/70 pr-2 ${collapsed ? "rounded-lg" : "rounded-t-lg"}`}>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={toggle}
          title={collapsed ? "Rozwiń sekcję" : "Zwiń sekcję"}
          className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-lg py-2 pl-3 text-left text-xs font-semibold tracking-wide text-[var(--foreground)]/75 uppercase hover:text-[var(--foreground)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <span aria-hidden className={`inline-block w-3 text-[var(--muted)] transition-transform ${collapsed ? "" : "rotate-90"}`}>
            ▸
          </span>
          {TASK_SECTION_ICON[id] ? (
            <span aria-hidden className="text-sm leading-none normal-case">
              {TASK_SECTION_ICON[id]}
            </span>
          ) : null}
          <span className="truncate">{title}</span>
          {count !== undefined && count !== null && count !== "" ? <span className="font-normal text-[var(--muted)] normal-case">· {count}</span> : null}
        </button>
        {actions ? <span className="flex shrink-0 items-center gap-1 normal-case">{actions}</span> : null}
      </div>
      {collapsed ? null : (
        <div id={bodyId} className="@container border-t border-[var(--line)] px-3 pt-3 pb-3">
          {locked ? (
            <fieldset disabled className="m-0 min-w-0 border-0 p-0">
              {children}
            </fieldset>
          ) : (
            children
          )}
        </div>
      )}
    </section>
  );
}
