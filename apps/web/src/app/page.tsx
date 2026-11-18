import { PRIORITY, TASK_STATUS } from "@taskplanner/core";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">TaskPlanner</h1>
      <p className="text-sm opacity-70">Szkielet z Etapu 0 — widoki powstają od MVP-2 (PLAN_ETAPOWY.md).</p>
      <ul className="flex flex-wrap gap-2 text-xs">
        {Object.entries(TASK_STATUS).map(([status, label]) => (
          <li key={status} className="rounded-full border border-[var(--line)] px-3 py-1">
            {label}
          </li>
        ))}
      </ul>
      <ul className="flex flex-wrap gap-2 text-xs">
        {Object.values(PRIORITY).map((priority) => (
          <li key={priority.short} className="rounded-full px-3 py-1 text-white" style={{ background: priority.color }}>
            {priority.label}
          </li>
        ))}
      </ul>
    </main>
  );
}
