"use client";

/** Znaczki osób zadania: odpowiedzialny (pełny), potem uczestnicy (obrys); nieznani pominięci. */
import { assigneeOf, collaboratorBadge, type ViewTask } from "@taskplanner/core";

import { useAppEnv } from "./app-env";

const SHOWN = 4;

export function PeopleBadges({ task, className = "" }: { task: ViewTask; className?: string }) {
  const { data } = useAppEnv();
  const assignee = assigneeOf(task.assigneeId, data.collaborators);
  const people = [
    ...(assignee ? [{ person: assignee, role: "Odpowiedzialny" }] : []),
    ...(data.participants.get(task.id) ?? [])
      .filter((id) => id !== task.assigneeId)
      .map((id) => assigneeOf(id, data.collaborators))
      .filter((c) => c !== null)
      .map((person) => ({ person, role: "Uczestnik" })),
  ];
  if (!people.length) return null;
  return (
    <span className={`flex shrink-0 items-center gap-0.5 ${className}`} data-testid="task-people">
      {people.slice(0, SHOWN).map(({ person, role }) => (
        <span
          key={person.id}
          title={`${role}: ${person.name}`}
          className={`relative inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold ${
            role === "Odpowiedzialny"
              ? "bg-sky-100 text-sky-900 dark:bg-sky-900/60 dark:text-sky-100"
              : "border border-sky-300 text-sky-800 dark:border-sky-700 dark:text-sky-200"
          }`}
        >
          {collaboratorBadge(person)}
          <span className="sr-only">
            {role}: {person.name}
          </span>
        </span>
      ))}
      {people.length > SHOWN ? (
        <span className="text-[10px] text-[var(--muted)]" title={people.slice(SHOWN).map(({ person }) => person.name).join(", ")}>
          +{people.length - SHOWN}
        </span>
      ) : null}
    </span>
  );
}
