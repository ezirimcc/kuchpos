import { CalendarClock, ClipboardList, PackagePlus, Truck, Warehouse } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";
import type { AppContext } from "@/server/auth/context";
import { can } from "@/server/permissions";

type Tab = "on-hand" | "receive" | "receipts" | "expiring" | "suppliers";

/** The row of links shared by the stock screens. Only the ones the person may open are shown. */
export function StockTabs({ context, current }: { context: AppContext; current: Tab }) {
  const tabs = [
    { key: "on-hand", href: "/stock", label: "Stock on hand", icon: Warehouse, show: can(context, "stock.view") },
    { key: "receive", href: "/stock/receive", label: "Receive goods", icon: PackagePlus, show: can(context, "stock.receive") },
    { key: "receipts", href: "/stock/receipts", label: "Deliveries", icon: ClipboardList, show: can(context, "stock.receipts.view") },
    { key: "expiring", href: "/stock/expiring", label: "Expiring soon", icon: CalendarClock, show: can(context, "report.stock.view") },
    { key: "suppliers", href: "/stock/suppliers", label: "Suppliers", icon: Truck, show: can(context, "stock.receipts.view") },
  ].filter((tab) => tab.show);

  return (
    <nav aria-label="Stock sections" className="flex w-fit max-w-full flex-wrap gap-1 rounded-full bg-card p-1 dark:border dark:border-border">
      {tabs.map(({ key, href, label, icon: Icon }) => (
        <Link
          key={key}
          href={href}
          aria-current={key === current ? "page" : undefined}
          className={cn(
            "flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors",
            key === current ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}
