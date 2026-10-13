import { ArrowLeftRight, BadgePercent, Boxes, ChartColumn, CloudOff, Download, HandCoins, Undo2, UserRoundCheck, Users, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";
import { formatDay, shopToday } from "@/lib/format";
import type { AppContext } from "@/server/auth/context";
import type { Period } from "@/server/business/reports";
import { can } from "@/server/permissions";

type Tab = "sales" | "collections" | "debts" | "stock-movements" | "customers" | "stock";

/** The row of links shared by the report screens. Only the ones the person may open are shown. */
export function ReportTabs({ context, current }: { context: AppContext; current: Tab | null }) {
  const tabs: { key: Tab | string; href: string; label: string; icon: LucideIcon; show: boolean }[] = [
    { key: "sales", href: "/reports/sales", label: "Sales", icon: ChartColumn, show: can(context, "report.sales.view") },
    { key: "collections", href: "/reports/collections", label: "Collections", icon: HandCoins, show: can(context, "report.collections.view") },
    { key: "customers", href: "/reports/customers", label: "Customers", icon: UserRoundCheck, show: can(context, "report.sales.view") && can(context, "customer.statement.view") },
    { key: "debts", href: "/reports/debts", label: "Customer debts", icon: Users, show: can(context, "report.customerDebt.view") },
    { key: "stock", href: "/reports/stock", label: "Stock figures", icon: Boxes, show: can(context, "report.stock.view") },
    { key: "stock-movements", href: "/reports/stock-movements", label: "Stock movements", icon: ArrowLeftRight, show: can(context, "report.stock.view") },
    { key: "returns", href: "/returns", label: "Returns", icon: Undo2, show: can(context, "report.sales.view") },
    { key: "discounts", href: "/sales/discounts", label: "Discounts & approvals", icon: BadgePercent, show: can(context, "report.discounts.view") },
    { key: "offline", href: "/sales/offline", label: "Offline exceptions", icon: CloudOff, show: can(context, "report.sales.view") },
  ].filter((tab) => tab.show);

  return (
    <nav aria-label="Reports" className="flex w-fit max-w-full flex-wrap gap-1 rounded-3xl bg-card p-1 dark:border dark:border-border">
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

const DAY_MS = 24 * 60 * 60 * 1000;
const dayBefore = (day: string, count: number) => new Date(new Date(`${day}T00:00:00.000Z`).getTime() - count * DAY_MS).toISOString().slice(0, 10);

/** Ready-made periods, in shop days: from today back to the last twelve months. */
export function quickPeriods(): { label: string; from: string; to: string }[] {
  const today = shopToday();
  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = dayBefore(monthStart, 1);
  return [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: dayBefore(today, 1), to: dayBefore(today, 1) },
    { label: "Last 7 days", from: dayBefore(today, 6), to: today },
    { label: "This month", from: monthStart, to: today },
    { label: "Last month", from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd },
    { label: "Last 30 days", from: dayBefore(today, 29), to: today },
    { label: "This year", from: `${today.slice(0, 4)}-01-01`, to: today },
    { label: "Last 12 months", from: dayBefore(today, 364), to: today },
  ];
}

/**
 * The periods used for analysis on the home page and on a product's or customer's page (C70):
 * today, this week (from Monday), this month, this quarter, this year — each up to today.
 */
export function analysisPeriods(): { label: string; from: string; to: string }[] {
  const today = shopToday();
  // Monday = 0 … Sunday = 6, for the calendar day the shop is in.
  const weekday = (new Date(`${today}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  const month = Number.parseInt(today.slice(5, 7), 10);
  const quarterStart = String(month - ((month - 1) % 3)).padStart(2, "0");
  return [
    { label: "Today", from: today, to: today },
    { label: "This week", from: dayBefore(today, weekday), to: today },
    { label: "This month", from: `${today.slice(0, 8)}01`, to: today },
    { label: "This quarter", from: `${today.slice(0, 5)}${quarterStart}-01`, to: today },
    { label: "This year", from: `${today.slice(0, 4)}-01-01`, to: today },
  ];
}

/** Links for the ready-made periods; the rest of the address (grouping, filters) is kept. */
export function PeriodLinks({
  path,
  period,
  keep,
  periods,
  anchor,
  picked,
}: {
  path: string;
  period: Period | { from: string; to: string };
  keep?: Record<string, string>;
  /** Which ready-made periods to offer; the report ones when left out. */
  periods?: { label: string; from: string; to: string }[];
  /** A place on the page to land on after choosing (without the #). */
  anchor?: string;
  /**
   * The label of the period that was clicked (the `p` in the address), when the page passes it
   * on. Two periods can cover the same days — in January, "This month", "This quarter" and
   * "This year" all do — and then only the one that was clicked is shown as chosen.
   */
  picked?: string;
}) {
  const extra = Object.entries(keep ?? {})
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `&${key}=${encodeURIComponent(value)}`)
    .join("");
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="period-links">
      {(periods ?? quickPeriods()).map((quick, index, all) => {
        const matches = (entry: { from: string; to: string }) => entry.from === period.from && entry.to === period.to;
        const pickedOne = all.find((entry) => entry.label === picked && matches(entry));
        // The one clicked, if it still fits the days shown; otherwise the first that fits.
        const chosen = matches(quick) && (pickedOne ? pickedOne.label === quick.label : all.findIndex(matches) === index);
        return (
          <Link
            key={quick.label}
            // Not fetched ahead of a click: each of these is a full set of figures for the server to work out.
            prefetch={false}
            href={`${path}?from=${quick.from}&to=${quick.to}${periods ? `&p=${encodeURIComponent(quick.label)}` : ""}${extra}${anchor ? `#${anchor}` : ""}`}
            aria-current={chosen ? "true" : undefined}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
              chosen ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground dark:border dark:border-border",
            )}
          >
            {quick.label}
          </Link>
        );
      })}
    </div>
  );
}

/** "1 Oct 2026" or "1 Oct 2026 – 10 Oct 2026". */
export function periodText(period: Period): string {
  return period.from === period.to ? formatDay(period.from) : `${formatDay(period.from)} – ${formatDay(period.to)}`;
}

/** A link that downloads the report on screen as a CSV file (it opens in Excel). Shown only to those who may export. */
export function ExportLink({
  context,
  report,
  list,
  params,
}: {
  context: AppContext;
  /** One of the reports… */
  report?: string;
  /** …or one of the list pages (Products, Customers, Sales and so on). */
  list?: string;
  /** The filters on screen, named as the operation behind the page names them. */
  params: Record<string, string>;
}) {
  if (!can(context, "report.export")) return null;
  const query = new URLSearchParams({ ...(list ? { list } : { report: report ?? "" }), ...Object.fromEntries(Object.entries(params).filter(([, value]) => value !== "")) });
  return (
    // A plain link on purpose: it is a file download, not a page of the app.
    <a
      href={`/reports/export?${query.toString()}`}
      download
      className="flex h-10 items-center gap-2 rounded-full border bg-card px-4 text-sm font-medium hover:bg-accent"
      data-testid="export-csv"
    >
      <Download className="size-4" aria-hidden /> Export for Excel (CSV)
    </a>
  );
}
