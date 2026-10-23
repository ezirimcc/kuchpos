import { can, type Permission, type PermissionSubject } from "./permissions";

export type NavItem = {
  label: string;
  /** Name of the icon shown beside the label (see src/components/side-nav.tsx). */
  icon: string;
  /** Empty when the screen has not been built yet. */
  href: string | null;
};

type NavEntry = { label: string; icon: string; href: string | null; anyOf: Permission[] };

const BUSINESS_MENU: NavEntry[] = [
  { label: "Sell", icon: "cart", href: "/sell", anyOf: ["sale.create"] },
  { label: "Sales", icon: "sales", href: "/sales", anyOf: ["report.sales.view", "report.ownShift.view"] },
  { label: "Till", icon: "till", href: "/till", anyOf: ["till.operateOwn", "till.reviewAny"] },
  { label: "Customers", icon: "customers", href: "/customers", anyOf: ["customer.manage", "customer.balance.view"] },
  { label: "Stock", icon: "stock", href: "/stock", anyOf: ["stock.view"] },
  { label: "Products & Categories", icon: "products", href: "/products", anyOf: ["product.manage", "price.manage", "price.view"] },
  {
    label: "Reports",
    icon: "reports",
    href: "/reports",
    // Opening the Reports pages is a permission of its own (C70): a manager has several of
    // the reports' permissions for other screens, but not this one.
    // A manager sees the Sales and Collections reports for the last 7 days (C82).
    anyOf: ["report.pages.view", "report.recent.view"],
  },
  { label: "Staff", icon: "staff", href: "/staff", anyOf: ["staff.manage"] },
  { label: "Activity log", icon: "activity", href: "/activity", anyOf: ["activityLog.view"] },
  { label: "Settings", icon: "settings", href: "/settings", anyOf: ["settings.manage"] },
];

const OWNER_MENU: NavEntry[] = [
  { label: "Overview", icon: "overview", href: "/owner/overview", anyOf: ["business.manage"] },
  { label: "Businesses", icon: "businesses", href: "/owner/businesses", anyOf: ["business.manage"] },
  { label: "Owners", icon: "owners", href: "/owner/owners", anyOf: ["owner.manage"] },
  { label: "System check", icon: "system", href: "/owner/system", anyOf: ["owner.manage"] },
  { label: "Error log", icon: "errors", href: "/owner/errors", anyOf: ["owner.manage"] },
  { label: "Backups", icon: "backups", href: "/owner/backups", anyOf: ["owner.manage"] },
];

function visible(subject: PermissionSubject, entries: NavEntry[]): NavItem[] {
  return entries
    .filter((entry) => entry.anyOf.some((permission) => can(subject, permission)))
    .map(({ label, icon, href }) => ({ label, icon, href }));
}

/**
 * The menu for the signed-in person. This only decides what is SHOWN;
 * every page and action checks the permission again on the server.
 */
export function menuFor(subject: PermissionSubject): { business: NavItem[]; owner: NavItem[] } {
  return { business: visible(subject, BUSINESS_MENU), owner: visible(subject, OWNER_MENU) };
}
