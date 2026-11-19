"use client";

/** Granica błędów strony (Next `error.js`): błąd widoku → dziennik błędów i ekran z ponowieniem. */
import { useEffect } from "react";

import { Button, Card } from "@/components/app/ui";
import { reportError } from "@/lib/error-log";

export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    const digest = error instanceof Error && "digest" in error ? String((error as { digest?: unknown }).digest ?? "") : "";
    reportError("render", error, digest ? { digest } : undefined);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 items-center px-4 py-16">
      <Card className="w-full">
        <h1 className="mb-2 text-base font-semibold">Coś poszło nie tak</h1>
        <p className="mb-4 text-sm text-[var(--muted)]">
          Błąd jest zapisany w dzienniku (Ustawienia → „Błędy aplikacji”). Twoje dane są w lokalnej bazie i nic nie przepadło.
        </p>
        <div className="flex gap-2">
          <Button kind="primary" onClick={() => retry()}>
            Spróbuj ponownie
          </Button>
          <Button kind="ghost" onClick={() => window.location.reload()}>
            Odśwież stronę
          </Button>
        </div>
      </Card>
    </main>
  );
}
