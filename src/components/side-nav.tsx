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

export type SideNavItem = { label: string; icon: string; href: string | null };

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

function NavLink({ item, active, collapsed }: { item: SideNavItem; active: boolean; collapsed: boolean }) {
  const Icon = ICONS[item.icon] ?? LayoutDashboard;
  const shape = cn(
    "flex items-center gap-3 rounded-2xl text-sm transition-colors",
    collapsed ? "size-11 justify-center" : "px-3 py-2.5",
  );
  const label = <span className={collapsed ? "sr-only" : "flex-1 truncate"}>{item.label}</span>;

  if (!item.href) {
    return (
      <span className={cn(shape, "text-sidebar-foreground/40")} title={collapsed ? `${item.label} (coming soon)` : undefined}>
        <Icon className="size-[18px] shrink-0" aria-hidden />
        {label}
        <span className={collapsed ? "sr-only" : "rounded-full bg-sidebar-accent px-2 py-0.5 text-[10px] tracking-wide"}>
          coming soon
        </span>
      </span>
    );
  }
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        shape,
        "font-medium",
        active
          ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <Icon className="size-[18px] shrink-0" aria-hidden />
      {label}
    </Link>
  );
}

function Group({
  title,
  items,
  pathname,
  collapsed,
}: {
  title: string;
  items: SideNavItem[];
  pathname: string;
  collapsed: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      {collapsed ? (
        <div className="mx-auto mb-2 h-px w-6 bg-sidebar-border" aria-hidden />
      ) : (
        <p className="truncate px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-sidebar-foreground/50 uppercase">
          {title}
        </p>
      )}
      <ul className={cn("flex flex-col gap-1", collapsed && "items-center")}>
        {items.map((item) => (
          <li key={item.label}>
            <NavLink
              item={item}
              collapsed={collapsed}
              active={!!item.href && (pathname === item.href || pathname.startsWith(`${item.href}/`))}
            />
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
  collapsed,
}: {
  businessTitle: string;
  business: SideNavItem[];
  owner: SideNavItem[];
  collapsed: boolean;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main menu" className={cn("flex flex-1 flex-col gap-5 overflow-y-auto p-3", collapsed && "items-center")}>
      <NavLink item={{ label: "Home", icon: "home", href: "/" }} active={pathname === "/"} collapsed={collapsed} />
      <Group title={businessTitle} items={business} pathname={pathname} collapsed={collapsed} />
      <Group title="All businesses" items={owner} pathname={pathname} collapsed={collapsed} />
    </nav>
  );
}
