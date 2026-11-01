// React binding for the hash router: subscribe to `hashchange`, always parse
// into the same `Route` union as the pure router.
import { useCallback, useEffect, useState } from "react";
import { parseRoute, routeToHash, type Route } from "./router.ts";

function currentHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

export function useHashRoute(): { route: Route; navigate: (route: Route) => void } {
  const [route, setRoute] = useState<Route>(() => parseRoute(currentHash()));

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    window.location.hash = routeToHash(next);
  }, []);

  return { route, navigate };
}
