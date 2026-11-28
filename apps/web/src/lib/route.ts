"use client";

/**
 * Widok aplikacji w części `#` adresu (`#/today`, `#/list/<id>`): odświeżenie i przycisk „Wstecz”
 * działają offline, bez tras Next.js (cała aplikacja to jedna strona nad lokalną bazą).
 */
import { useCallback, useSyncExternalStore } from "react";

export type Route =
  | { view: "home" }
  | { view: "inbox" }
  | { view: "today" }
  | { view: "overdue" }
  | { view: "upcoming" }
  | { view: "undated" }
  | { view: "board" }
  | { view: "calendar" }
  | { view: "timeline" }
  | { view: "focus"; id?: string }
  | { view: "review"; id: "daily" | "weekly" }
  | { view: "habits" }
  | { view: "habit"; id: string }
  | { view: "list"; id: string }
  | { view: "tag"; id: string }
  | { view: "filter"; id: string }
  | { view: "manage" }
  | { view: "trash" }
  | { view: "people" }
  | { view: "settings"; id?: string }
  | { view: "deliveries" }
  | { view: "notifications" }
  | { view: "changelog" };

/** Strona startowa: po zalogowaniu (pusty `#`) i po kliknięciu „Task Planner” w nagłówku. */
export const DEFAULT_ROUTE: Route = { view: "home" };

export function parseRoute(hash: string): Route {
  const [view, id] = hash.replace(/^#\/?/, "").split("/");
  switch (view) {
    case "home":
    case "inbox":
    case "today":
    case "overdue":
    case "upcoming":
    case "undated":
    case "board":
    case "calendar":
    case "timeline":
    case "habits":
    case "manage":
    case "trash":
    case "people":
    case "deliveries":
    case "notifications":
    case "changelog":
      return { view };
    case "list":
    case "tag":
    case "filter":
      return id ? { view, id } : DEFAULT_ROUTE;
    case "focus":
    case "settings":
      return id ? { view, id } : { view };
    case "review":
      return { view, id: id === "weekly" ? "weekly" : "daily" };
    case "habit":
      return id ? { view, id } : { view: "habits" };
    default:
      return DEFAULT_ROUTE;
  }
}

export const routeHash = (route: Route): string => ("id" in route && route.id ? `#/${route.view}/${route.id}` : `#/${route.view}`);

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
