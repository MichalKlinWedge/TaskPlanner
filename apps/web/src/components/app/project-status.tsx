"use client";

/** Status projektu (M2): aktywny / wstrzymany / zakończony — wybór, a przy podglądzie sam napis. */
import { PROJECT_STATUS, type ProjectStatus } from "@taskplanner/core";

import { Select } from "./ui";

export function ProjectStatusSelect({ name, value, onChange }: { name: string; value: ProjectStatus | null; onChange?: (status: ProjectStatus) => void }) {
  const status = value ?? "active";
  if (!onChange) return <span className="rounded bg-[var(--hover)] px-2 py-0.5 text-xs">{PROJECT_STATUS[status]}</span>;
  return (
    <Select
      value={status}
      onChange={(e) => onChange(e.target.value as ProjectStatus)}
      aria-label={`Status projektu: ${name}`}
      title="Status projektu — wstrzymany i zakończony nie wracają w przeglądzie tygodnia"
      className="py-0.5 text-xs"
    >
      {(Object.keys(PROJECT_STATUS) as ProjectStatus[]).map((s) => (
        <option key={s} value={s}>
          {PROJECT_STATUS[s]}
        </option>
      ))}
    </Select>
  );
}
