"use client";

/**
 * Błąd w samym układzie strony (Next `global-error.js`) — zastępuje cały dokument, bez globalnych stylów
 * i motywu, więc wygląd jest tu wpisany wprost (i idzie za motywem systemu).
 */
import { useEffect } from "react";

import { reportError } from "@/lib/error-log";

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => reportError("render", error, { boundary: "global" }), [error]);

  return (
    <html lang="pl">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "system-ui, sans-serif", colorScheme: "light dark" }}>
        <title>Task Planner — błąd</title>
        <main style={{ maxWidth: 420, padding: 24 }}>
          <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Coś poszło nie tak</h1>
          <p style={{ fontSize: 14, opacity: 0.75, margin: "0 0 16px" }}>Błąd jest zapisany w dzienniku. Twoje dane są w lokalnej bazie i nic nie przepadło.</p>
          <button type="button" onClick={() => retry()} style={{ padding: "6px 12px", marginRight: 8 }}>
            Spróbuj ponownie
          </button>
          <button type="button" onClick={() => window.location.reload()} style={{ padding: "6px 12px" }}>
            Odśwież stronę
          </button>
        </main>
      </body>
    </html>
  );
}
