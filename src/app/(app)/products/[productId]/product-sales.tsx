import Link from "next/link";
import { Suspense } from "react";
import { PeriodLinks, analysisPeriods, periodText } from "@/app/(app)/reports/report-parts";
import { LineChart } from "@/components/charts";
import { FilterDate } from "@/components/filters";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatMonth, formatShortDay, nairaFromText, plainNumber } from "@/lib/format";
import type { AppContext } from "@/server/auth/context";
import { getProductSales } from "@/server/business/analysis";
import { ValidationError } from "@/server/errors";

/**
 * How this product has sold (C70): a line over the chosen period, the customers who bought it
 * with how much each bought, and each sale of it with a link to the sale. For those who read
 * the sales report and may open Reports (admin, accountant, owner).
 */
export async function ProductSales({ context, productId, from, to, picked }: { context: AppContext; productId: string; from: string; to: string; picked: string }) {
  const periods = analysisPeriods();
  const thisMonth = periods[2];
  // This month so far, unless a period was chosen.
  const asked = from || to ? { from, to } : { from: thisMonth.from, to: thisMonth.to };
  let sales: Awaited<ReturnType<typeof getProductSales>>;
  let problem: string | null = null;
  try {
    sales = await getProductSales(context, { productId, ...asked });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    problem = error.message;
    sales = await getProductSales(context, { productId, from: thisMonth.from, to: thisMonth.to });
  }
  const { period, grain, product } = sales;
  const label = (key: string) => (grain === "hour" ? key : grain === "day" ? formatShortDay(key) : formatMonth(key));
  const unit = product.unitName;

  return (
    <Card id="sales" data-testid="product-sales-card">
      <CardHeader>
        <CardTitle>How it has sold</CardTitle>
        <CardDescription>
          {periodText(period)}: {nairaFromText(sales.amount)} from {plainNumber(sales.quantity)} {unit} in {sales.salesCount} {sales.salesCount === 1 ? "sale" : "sales"}, after discounts and
          returns. Cancelled sales are left out.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <PeriodLinks path={`/products/${productId}`} period={period} periods={periods} anchor="sales" picked={picked} />
          <Suspense>
            <FilterDate name="from" label="From" />
            <FilterDate name="to" label="To" />
          </Suspense>
        </div>
        {problem && <p className="text-sm text-destructive">{problem} Showing this month instead.</p>}

        <LineChart
          testId="product-sales-chart"
          title={grain === "hour" ? "Sales by hour of the day" : grain === "day" ? "Sales, day by day" : "Sales, month by month"}
          points={sales.series.map((point) => ({ label: label(point.key), value: point.amount, shown: `${nairaFromText(point.amount)} (${plainNumber(point.quantity)} ${unit})` }))}
        />

        {sales.customers.length === 0 ? (
          <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">Not sold in this period.</p>
        ) : (
          <>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Who bought it</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Sales</TableHead>
                    <TableHead>Latest sale</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sales.customers.map((buyer) => (
                    <TableRow key={buyer.customerId ?? "walk-in"} data-testid="product-buyer-row">
                      <TableCell className="font-medium">
                        {buyer.customerId ? (
                          <Link href={`/customers/${buyer.customerId}`} className="text-link underline-offset-4 hover:underline">
                            {buyer.name}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">{buyer.name}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {plainNumber(buyer.quantity)} {unit}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{nairaFromText(buyer.amount)}</TableCell>
                      <TableCell className="text-right tabular-nums">{buyer.salesCount}</TableCell>
                      <TableCell>
                        <Link href={`/sales/${buyer.lastSale.id}`} className="text-link underline-offset-4 hover:underline">
                          {buyer.lastSale.receiptNumber}
                        </Link>
                        <span className="ml-2 text-xs text-muted-foreground">{formatDateTime(buyer.lastSale.at)}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold">
                Each sale of it, newest first{sales.purchases.length === 200 ? " (the latest 200; choose a shorter period to see earlier ones)" : ""}
              </h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Receipt</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Sold</TableHead>
                    <TableHead className="text-right">Amount, after returns</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sales.purchases.map((purchase, index) => (
                    <TableRow key={`${purchase.saleId}-${index}`} data-testid="product-purchase-row">
                      <TableCell>{formatDateTime(purchase.at)}</TableCell>
                      <TableCell>
                        <Link href={`/sales/${purchase.saleId}`} className="text-link underline-offset-4 hover:underline">
                          {purchase.receiptNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {purchase.customerId ? (
                          <Link href={`/customers/${purchase.customerId}`} className="text-link underline-offset-4 hover:underline">
                            {purchase.customerName}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {plainNumber(purchase.sold)} {purchase.unitName}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{nairaFromText(purchase.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
