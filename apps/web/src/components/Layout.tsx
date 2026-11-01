// Page shell: header, side navigation and the content area. The skip link
// ("main content") is rendered by the page component instead of here to keep the
// shell free of extra copy.
import type { ReactNode } from "react";
import type { ConnectionState } from "../api/useEventStream.ts";
import type { NavName } from "../router.ts";
import { SideNav } from "./SideNav.tsx";
import { TopBar } from "./TopBar.tsx";

export function Layout({
  projectName,
  connection,
  active,
  children,
}: {
  projectName: string | null;
  connection: ConnectionState;
  active: NavName;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <TopBar projectName={projectName} connection={connection} />
      <SideNav active={active} />
      <main className="main" id="main-content" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
