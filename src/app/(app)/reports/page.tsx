import { ChartColumn } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePageContext } from "@/server/auth/request";
import { can } from "@/server/permissions";
import { ReportTabs } from "./report-parts";

export const metadata: Metadata = { title: "Reports — KuchPos" };

export default async function ReportsPage() {
  const context = await requirePageContext();
  const cards = [
    { href: "/reports/sales", title: "Sales", text: "What was sold, returned and earned: by day, product, category, cashier, hour and how it was paid.", show: can(context, "report.sales.view") },
    { href: "/reports/collections", title: "Collections", text: "Money actually received, by payment method — for sales and against debts, less what was given back.", show: can(context, "report.collections.view") },
    { href: "/reports/debts", title: "Customer debts", text: "Who owes what, and for how long.", show: can(context, "report.customerDebt.view") },
    { href: "/reports/stock-movements", title: "Stock movements", text: "Everything that came in, went out or moved between the Shelf and the Storeroom.", show: can(context, "report.stock.view") },
    { href: "/stock", title: "Stock on hand", text: "What is on the Shelf and in the Storeroom now.", show: can(context, "stock.view") },
    { href: "/stock/expiring", title: "Expiring soon", text: "Deliveries whose expiry date is near.", show: can(context, "report.stock.view") },
    { href: "/returns", title: "Returns", text: "Goods customers brought back, and what was refunded.", show: can(context, "report.sales.view") },
    { href: "/sales/discounts", title: "Discounts and approvals", text: "Every discount, credit over a limit and return that was approved, and by whom.", show: can(context, "report.discounts.view") },
    { href: "/sales/offline", title: "Offline exceptions", text: "What was out of the ordinary about sales made without internet.", show: can(context, "report.sales.view") },
    { href: "/sales", title: "My sales", text: "The sales you have made.", show: !can(context, "report.sales.view") && can(context, "report.ownShift.view") },
  ].filter((card) => card.show);
  if (cards.length === 0) redirect("/");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader icon={ChartColumn} title="Reports" description="Figures come from what was recorded when each sale, payment or stock movement happened. Nothing here can be changed." />
      <ReportTabs context={context} current={null} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => (
          <Link key={card.href} href={card.href} className="rounded-3xl bg-card p-5 transition-colors hover:bg-accent dark:border dark:border-border" data-testid="report-card">
            <p className="font-semibold">{card.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{card.text}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
