"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Otwarta rozwijana lista / okienko zamyka się po naciśnięciu poza jej elementami (zwykle: przycisk
 * z listą we wspólnym `ref`, żeby ponowny klik w przycisk zamykał, a nie otwierał od nowa).
 * Faza przechwytywania: np. karty i strzałki tablicy zatrzymują zdarzenie, zanim dotrze do dokumentu.
 */
export function useClickOutside(open: boolean, onClose: () => void, ...refs: RefObject<Element | null>[]): void {
  const latest = useRef({ onClose, refs });
  useEffect(() => {
    latest.current = { onClose, refs };
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const { onClose: close, refs: inside } = latest.current;
      if (!inside.some((r) => r.current?.contains(e.target as Node))) close();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);
}
