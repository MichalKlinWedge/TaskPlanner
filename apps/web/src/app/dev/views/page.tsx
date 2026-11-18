import { notFound } from "next/navigation";

import { ViewsLab } from "@/components/views/views-lab";

// PoC-5: kanban, kalendarz, oś czasu i Markdown na lokalnej bazie. Tylko w trybie deweloperskim.
export default function ViewsLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ViewsLab />;
}
