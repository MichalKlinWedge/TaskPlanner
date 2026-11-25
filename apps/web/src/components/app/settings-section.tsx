"use client";

/** Panel sekcji Ustawień (`settings-screen.tsx`): tytuł i karta z treścią. */
import type { ReactNode } from "react";

import { Card } from "./ui";

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h2 className="mb-4 text-xl font-semibold">{title}</h2>
      <Card>{children}</Card>
    </>
  );
}
