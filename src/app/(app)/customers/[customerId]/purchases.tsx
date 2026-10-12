import Link from "next/link";
import { Suspense } from "react";
import { PeriodLinks, analysisPeriods, periodText } from "@/app/(app)/reports/report-parts";
import { BarList } from "@/components/charts";
import { FilterDate } from "@/components/filters";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, nairaFromText, plainNumber } from "@/lib/format";
import type { AppContext } from "@/server/auth/context";
import { getCustomerPurchases } from "@/server/business/analysis";
import { ValidationError } from "@/server/errors";

const CHART_TOP = 10;

/**
 * What this customer bought in a period (C70): the products with the quantity and amount
 * spent on each, drawn as bars, and the purchases one by one. For those who may see what
 * customers have bought (admin, accountant, owner).
 */
export async function CustomerPurchases({ context, customerId, from, to, picked }: { context: AppContext; customerId: string; from: string; to: string; picked: string }) {
  const periods = analysisPeriods();
  const thisYear = periods[4];
  // This year so far, unless a period was chosen.
  const asked = from || to ? { from, to } : { from: thisYear.from, to: thisYear.to };
  let bought: Awaited<ReturnType<typeof getCustomerPurchases>>;
  let problem: string | null = null;
  try {
    bought = await getCustomerPurchases(context, { customerId, ...asked });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    problem = error.message;
    bought = await getCustomerPurchases(context, { customerId, from: thisYear.from, to: thisYear.to });
  }
  const { period, products, sales } = bought;
  const path = `/customers/${customerId}`;

  return (
    <Card id="purchases" data-testid="customer-purchases-card">
      <CardHeader>
        <CardTitle>What they bought</CardTitle>
        <CardDescription>
          {periodText(period)}: {bought.salesCount} {bought.salesCount === 1 ? "purchase" : "purchases"}, {nairaFromText(bought.spent)} after discounts and returns.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <PeriodLinks path={path} period={period} periods={periods} anchor="purchases" picked={picked} />
          <Suspense>
            <FilterDate name="from" label="From" />
            <FilterDate name="to" label="To" />
          </Suspense>
        </div>
        {problem && <p className="text-sm text-destructive">{problem} Showing this year instead.</p>}

        {products.length === 0 ? (
          <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">Nothing bought in this period.</p>
        ) : (
          <>
            {products.length > 1 && (
              <BarList
                testId="customer-products-chart"
                title="Amount spent, by product"
                note={products.length > CHART_TOP ? `The ${CHART_TOP} largest of ${products.length}; all are in the table below.` : undefined}
                points={products.slice(0, CHART_TOP).map((product) => ({ label: product.name, value: product.amount, shown: nairaFromText(product.amount) }))}
              />
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Amount spent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((product) => (
                  <TableRow key={product.productId} data-testid="customer-product-row">
                    <TableCell className="font-medium">
                      <Link href={`/products/${product.productId}`} className="text-link underline-offset-4 hover:underline">
                        {product.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {plainNumber(product.quantity)} {product.unitName}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{nairaFromText(product.amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="font-semibold">Total</TableCell>
                  <TableCell />
                  <TableCell className="text-right font-semibold tabular-nums">{nairaFromText(bought.spent)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>

            <div>
              <h3 className="mb-2 text-sm font-semibold">
                Purchases, newest first{bought.salesCount > sales.length ? ` (the latest ${sales.length} of ${bought.salesCount}; choose a shorter period to see earlier ones)` : ""}
              </h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Receipt</TableHead>
                    <TableHead className="text-right">Items</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">On credit</TableHead>
                    <TableHead className="text-right">Refunded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sales.map((sale) => (
                    <TableRow key={sale.id} data-testid="customer-purchase-row">
                      <TableCell>{formatDateTime(sale.at)}</TableCell>
                      <TableCell>
                        <Link href={`/sales/${sale.id}`} className="text-link underline-offset-4 hover:underline">
                          {sale.receiptNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{sale.items}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{nairaFromText(sale.total)}</TableCell>
                      <TableCell className="text-right tabular-nums">{sale.onCredit === "0.00" ? "—" : nairaFromText(sale.onCredit)}</TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">{sale.refunded === "0.00" ? "—" : `−${nairaFromText(sale.refunded)}`}</TableCell>
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
