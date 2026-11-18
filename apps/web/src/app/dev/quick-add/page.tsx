import { notFound } from "next/navigation";

import { QuickAddLab } from "@/components/quick-add-lab";

// PoC-2: podgląd parsera szybkiego dodawania (podświetlanie i chipy). Tylko w trybie deweloperskim.
export default function QuickAddLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <QuickAddLab />;
}
