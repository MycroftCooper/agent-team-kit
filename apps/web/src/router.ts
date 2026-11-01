// Hash router. Deliberately tiny: the SPA is served by the backend with an
// `index.html` fallback, so real paths would need server config; hashes keep the
// shell working in `vite dev`, in `vite preview` and behind the backend alike.
// Pure functions so `node:test` can cover the mapping (no DOM needed).
import type { MessageKey } from "./i18n/en.ts";

export type NavName = "overview" | "tasks" | "agents" | "reviews" | "settings";

export type Route =
  | { name: "overview" }
  | { name: "tasks" }
  | { name: "task"; id: string }
  | { name: "agents" }
  | { name: "reviews" }
  | { name: "settings" };

export const NAV_ITEMS: readonly { name: NavName; href: string; labelKey: MessageKey }[] = [
  { name: "overview", href: "#/overview", labelKey: "nav.overview" },
  { name: "tasks", href: "#/tasks", labelKey: "nav.tasks" },
  { name: "agents", href: "#/agents", labelKey: "nav.agents" },
  { name: "reviews", href: "#/reviews", labelKey: "nav.reviews" },
  { name: "settings", href: "#/settings", labelKey: "nav.settings" },
];

/** `#/tasks/T-42` -> `{name:"task", id:"T-42"}`; anything unknown -> overview. */
export function parseRoute(hash: string | null | undefined): Route {
  const cleaned = String(hash ?? "")
    .replace(/^#/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (cleaned === "") return { name: "overview" };
  const segments = cleaned.split("/");
  const head = segments[0];
  const rest = segments.slice(1).filter((segment) => segment !== "");

  switch (head) {
    case "tasks": {
      if (rest.length === 0) return { name: "tasks" };
      const id = decodeURIComponent(rest.join("/"));
      return id === "" ? { name: "tasks" } : { name: "task", id };
    }
    case "agents":
      return { name: "agents" };
    case "reviews":
      return { name: "reviews" };
    case "settings":
      return { name: "settings" };
    case "overview":
      return { name: "overview" };
    default:
      return { name: "overview" };
  }
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case "task":
      return `#/tasks/${encodeURIComponent(route.id)}`;
    case "tasks":
      return "#/tasks";
    case "agents":
      return "#/agents";
    case "reviews":
      return "#/reviews";
    case "settings":
      return "#/settings";
    case "overview":
    default:
      return "#/overview";
  }
}

/** Which nav item should look active for the current route. */
export function navNameOf(route: Route): NavName {
  return route.name === "task" ? "tasks" : route.name;
}
