import { notFound } from "next/navigation";

import { RecurrenceLab } from "@/components/recurrence-lab";

// PoC-3: przypadki cykliczności i nawyków liczone w przeglądarce (te same co w Vitest). Tylko dev.
export default function RecurrenceLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <RecurrenceLab />;
}
