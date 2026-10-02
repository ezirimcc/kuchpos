import { can, type Permission, type PermissionSubject } from "./permissions";

export type NavItem = {
  label: string;
  /** Empty when the screen has not been built yet. */
  href: string | null;
};

type NavEntry = { label: string; href: string | null; anyOf: Permission[] };

const BUSINESS_MENU: NavEntry[] = [
  { label: "Sell", href: null, anyOf: ["sale.create"] },
  { label: "Customers", href: null, anyOf: ["customer.manage", "customer.balance.view"] },
  { label: "Stock", href: null, anyOf: ["stock.receive", "stock.transfer", "stock.count"] },
  { label: "Products & prices", href: null, anyOf: ["product.manage", "price.manage"] },
  {
    label: "Reports",
    href: null,
    anyOf: [
      "report.sales.view",
      "report.collections.view",
      "report.ownShift.view",
      "report.stock.view",
      "report.customerDebt.view",
    ],
  },
  { label: "Staff", href: "/staff", anyOf: ["staff.manage"] },
  { label: "Activity log", href: "/activity", anyOf: ["activityLog.view"] },
  { label: "Settings", href: "/settings", anyOf: ["settings.manage"] },
];

const OWNER_MENU: NavEntry[] = [
  { label: "Businesses", href: "/owner/businesses", anyOf: ["business.manage"] },
  { label: "Owners", href: "/owner/owners", anyOf: ["owner.manage"] },
];

function visible(subject: PermissionSubject, entries: NavEntry[]): NavItem[] {
  return entries
    .filter((entry) => entry.anyOf.some((permission) => can(subject, permission)))
    .map(({ label, href }) => ({ label, href }));
}

/**
 * The menu for the signed-in person. This only decides what is SHOWN;
 * every page and action checks the permission again on the server.
 */
export function menuFor(subject: PermissionSubject): { business: NavItem[]; owner: NavItem[] } {
  return { business: visible(subject, BUSINESS_MENU), owner: visible(subject, OWNER_MENU) };
}
