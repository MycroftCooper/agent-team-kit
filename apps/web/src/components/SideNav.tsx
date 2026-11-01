// Left navigation. Plain hash links: they work without a router library and are
// keyboard/reload friendly. `aria-current="page"` marks the active section.
import { NAV_ITEMS, type NavName } from "../router.ts";
import { useT } from "../i18n/index.tsx";

export function SideNav({ active }: { active: NavName }) {
  const t = useT();
  return (
    <nav className="sidenav" aria-label={t("nav.ariaLabel")}>
      <ul className="sidenav__list">
        {NAV_ITEMS.map((item) => (
          <li key={item.name} className="sidenav__item">
            <a
              className="sidenav__link"
              href={item.href}
              data-testid={`nav-${item.name}`}
              aria-current={item.name === active ? "page" : undefined}
            >
              {t(item.labelKey)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
