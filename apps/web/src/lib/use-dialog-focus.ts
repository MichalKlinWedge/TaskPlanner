/**
 * Fokus okna modalnego (`aria-modal`): Tab / Shift+Tab krąży po elementach okna zamiast wychodzić na stronę
 * pod spodem, a po zamknięciu fokus wraca do elementu, który był aktywny przed otwarciem (np. pozycja listy
 * przed Ctrl+K). Sam początkowy fokus ustawia okno (pole wyszukiwania, przycisk…).
 *
 * „Element przed otwarciem” = ostatni fokus poza oknami (`focusin` na dokumencie): `autoFocus` pola okna
 * dzieje się przed efektem, więc `document.activeElement` w efekcie byłby już polem okna.
 */
import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let lastOutside: HTMLElement | null = null;
let tracking = false;

function track() {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  if (document.activeElement instanceof HTMLElement && !document.activeElement.closest("[aria-modal]")) lastOutside = document.activeElement;
  document.addEventListener(
    "focusin",
    (e) => {
      if (e.target instanceof HTMLElement && !e.target.closest("[aria-modal]")) lastOutside = e.target;
    },
    true,
  );
}
track();

export function useDialogFocus(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    if (!active) return;
    track();
    const before = lastOutside;
    const onKey = (e: KeyboardEvent) => {
      const box = ref.current;
      if (e.key !== "Tab" || !box) return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = box.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Po zamknięciu: z powrotem tam, skąd otwarto (o ile ten element nadal jest na stronie).
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [ref, active]);
}
