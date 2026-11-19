"use client";

/**
 * Widok aplikacji w części `#` adresu (`#/today`, `#/list/<id>`): odświeżenie i przycisk „Wstecz”
 * działają offline, bez tras Next.js (cała aplikacja to jedna strona nad lokalną bazą).
 */
import { useCallback, useSyncExternalStore } from "react";

export type Route =
  | { view: "inbox" }
  | { view: "today" }
  | { view: "upcoming" }
  | { view: "list"; id: string }
  | { view: "manage" }
  | { view: "trash" }
  | { view: "settings" };

export const DEFAULT_ROUTE: Route = { view: "today" };

export function parseRoute(hash: string): Route {
  const [view, id] = hash.replace(/^#\/?/, "").split("/");
  switch (view) {
    case "inbox":
    case "today":
    case "upcoming":
    case "manage":
    case "trash":
    case "settings":
      return { view };
    case "list":
      return id ? { view: "list", id } : DEFAULT_ROUTE;
    default:
      return DEFAULT_ROUTE;
  }
}

export const routeHash = (route: Route): string => (route.view === "list" ? `#/list/${route.id}` : `#/${route.view}`);

const subscribe = (listener: () => void) => {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
};

export function useRoute(): [Route, (route: Route) => void] {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  const navigate = useCallback((route: Route) => {
    window.location.hash = routeHash(route);
  }, []);
  return [parseRoute(hash), navigate];
}
