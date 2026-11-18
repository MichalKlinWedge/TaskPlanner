import { notFound } from "next/navigation";

import { SyncLab } from "@/components/sync-lab";

// PoC-1: ręczne sprawdzenie lokalnej bazy w przeglądarce i kilku kart. Tylko w trybie deweloperskim.
export default function SyncLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SyncLab />;
}
