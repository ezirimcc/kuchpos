import { TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime, plainNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listStockOwed } from "@/server/business/stock";
import { can } from "@/server/permissions";
import { StockTabs } from "../stock-tabs";

export const metadata: Metadata = { title: "Sold beyond stock — KuchPos" };

export default async function StockOwedPage() {
  const context = await requirePagePermission("report.stock.view");
  const list = await listStockOwed(context);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={TriangleAlert}
        title="Sold beyond stock"
        description="Sales made without internet are always accepted. When one took more than the system held in a place, that place is left owing the rest. It is settled by itself as soon as stock arrives there."
      />
      <StockTabs context={context} current="owed" />

      {list.rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground" data-testid="nothing-owed">
          Nothing is owed: every sale is covered by stock.
        </p>
      ) : (
        <>
          <p className="rounded-3xl bg-destructive px-5 py-4 text-sm font-semibold text-white" data-testid="owed-summary">
            Unreconciled offline sales: {list.salesCount}. For each product below, find out why the system held less than was sold, then do the one that
            matches what really happened.
          </p>
          <ul className="grid gap-1 px-1 text-sm text-muted-foreground">
            <li>• The goods were in the other place (for example the Storeroom) and were carried over without being recorded: <strong className="text-foreground">make a transfer</strong> into the place that owes.</li>
            <li>• The goods had arrived from a supplier but the delivery was never recorded: <strong className="text-foreground">record the delivery</strong> into that place.</li>
            <li>• The count was simply wrong: <strong className="text-foreground">record an adjustment</strong> upwards in that place, with a reason.</li>
          </ul>
          <div className="flex flex-col gap-3">
            {list.rows.map((row) => (
              <Card key={`${row.productId}-${row.locationId}`} data-testid="owed-row">
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-lg font-semibold">
                      <Link href={`/products/${row.productId}`} className="underline-offset-4 hover:underline">
                        {row.productName}
                      </Link>{" "}
                      <span className="font-normal text-muted-foreground">in {row.locationName}</span>
                    </p>
                    <p className="text-lg font-semibold text-destructive tabular-nums" data-testid="owed-quantity">
                      −{plainNumber(row.owed)} {row.unitName}
                    </p>
                  </div>
                  <ul className="rounded-2xl bg-muted/50 px-4 py-2 text-sm">
                    {row.sales.map((sale) => (
                      <li key={sale.saleId} className="flex flex-wrap justify-between gap-3 py-0.5">
                        <span>
                          <Link href={`/sales/${sale.saleId}`} className="text-link underline-offset-4 hover:underline">
                            {sale.receiptNumber}
                          </Link>{" "}
                          <span className="text-muted-foreground">
                            · {formatDateTime(sale.at)} · {sale.cashierName}
                          </span>
                        </span>
                        <span className="tabular-nums">
                          {plainNumber(sale.short)} {row.unitName} not covered
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    {can(context, "stock.transfer") && (
                      <Link href="/stock/transfers/new" className={buttonVariants({ variant: "outline", size: "sm" })}>
                        Make a transfer
                      </Link>
                    )}
                    {can(context, "stock.receive") && (
                      <Link href="/stock/receive" className={buttonVariants({ variant: "outline", size: "sm" })}>
                        Record a delivery
                      </Link>
                    )}
                    {can(context, "stock.adjust.request") && (
                      <Link href="/stock/adjustments/new" className={buttonVariants({ variant: "outline", size: "sm" })}>
                        Record an adjustment
                      </Link>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
