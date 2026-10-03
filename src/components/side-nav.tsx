"use client";

import {
  ChartColumn,
  History,
  LayoutDashboard,
  type LucideIcon,
  Package,
  ServerCog,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  UserCog,
  Users,
  Warehouse,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

type Item = { label: string; icon: string; href: string | null };

const ICONS: Record<string, LucideIcon> = {
  home: LayoutDashboard,
  cart: ShoppingCart,
  customers: Users,
  stock: Warehouse,
  products: Package,
  reports: ChartColumn,
  staff: UserCog,
  activity: History,
  settings: Settings,
  businesses: Store,
  owners: ShieldCheck,
  system: ServerCog,
};

function NavLink({ item, active }: { item: Item; active: boolean }) {
  const Icon = ICONS[item.icon] ?? LayoutDashboard;
  if (!item.href) {
    return (
      <span className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground/45">
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">{item.label}</span>
        <span className="rounded-full border border-sidebar-border px-1.5 py-px text-[10px] tracking-wide">
          coming soon
        </span>
      </span>
    );
  }
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {item.label}
    </Link>
  );
}

function Group({ title, items, pathname }: { title: string; items: Item[]; pathname: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="truncate px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-sidebar-foreground/50 uppercase">
        {title}
      </p>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.label}>
            <NavLink item={item} active={!!item.href && (pathname === item.href || pathname.startsWith(`${item.href}/`))} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The side menu. It only decides what is shown; every page checks permissions itself. */
export function SideNav({
  businessTitle,
  business,
  owner,
}: {
  businessTitle: string;
  business: Item[];
  owner: Item[];
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main menu" className="flex flex-1 flex-col gap-5 overflow-y-auto p-3">
      <NavLink item={{ label: "Home", icon: "home", href: "/" }} active={pathname === "/"} />
      <Group title={businessTitle} items={business} pathname={pathname} />
      <Group title="All businesses" items={owner} pathname={pathname} />
    </nav>
  );
}
