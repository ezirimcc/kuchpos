import Link from "next/link";
import { Suspense } from "react";
import { PeriodLinks, analysisPeriods, periodText } from "@/app/(app)/reports/report-parts";
import { FilterDate } from "@/components/filters";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatDay, plainNumber, signedNumber } from "@/lib/format";
import { MOVEMENT_LABELS } from "@/lib/movement-labels";
import type { AppContext } from "@/server/auth/context";
import { getProductStockHistory } from "@/server/business/stock";
import { ValidationError } from "@/server/errors";

/**
 * Every movement of this product's stock in a period, oldest first, with what was left
 * afterwards (C74) — for tracking and audits. For those who read stock records.
 */
export async function StockHistory({ context, productId, from, to, picked }: { context: AppContext; productId: string; from: string; to: string; picked: string }) {
  const periods = analysisPeriods();
  const thisMonth = periods[2];
  const asked = from || to ? { from, to } : { from: thisMonth.from, to: thisMonth.to };
  let history: Awaited<ReturnType<typeof getProductStockHistory>>;
  let problem: string | null = null;
  try {
    history = await getProductStockHistory(context, { productId, ...asked });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    problem = error.message;
    history = await getProductStockHistory(context, { productId, from: thisMonth.from, to: thisMonth.to });
  }
  const { period, locations, opening, closing } = history;
  const unit = history.product.baseUnitName;

  /** A row that is not a movement: what was held when the period began, or when it ended. */
  const heldRow = (label: string, day: string, figures: typeof opening, testId: string) => (
    <TableRow key={testId} className="bg-muted/50 font-medium" data-testid={testId}>
      <TableCell className="whitespace-nowrap">{formatDay(day)}</TableCell>
      <TableCell colSpan={3}>
        {label}: {locations.map((location) => `${location.name} ${plainNumber(figures.byLocation[location.id] ?? "0")}`).join(" · ")}
      </TableCell>
      <TableCell />
      <TableCell className="text-right tabular-nums">
        {plainNumber(figures.total)} {unit}
      </TableCell>
      <TableCell colSpan={2} />
    </TableRow>
  );

  return (
    <Card id="stock-history" data-testid="stock-history-card">
      <CardHeader>
        <CardTitle>Stock history</CardTitle>
        <CardDescription>
          {periodText({ ...period, days: 0 })}: {plainNumber(history.cameIn)} {unit} came in and {plainNumber(history.wentOut)} {unit} went out. Every movement in
          order, with what was left afterwards. Nothing here can be changed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <PeriodLinks path={`/products/${productId}`} period={period} periods={periods} anchor="stock-history" picked={picked} />
          <Suspense>
            <FilterDate name="from" label="From" />
            <FilterDate name="to" label="To" />
          </Suspense>
        </div>
        {problem && <p className="text-sm text-destructive">{problem} Showing this month instead.</p>}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>What happened</TableHead>
              <TableHead>Place</TableHead>
              <TableHead className="text-right">In / out</TableHead>
              <TableHead className="text-right">Left there</TableHead>
              <TableHead className="text-right">Left in all</TableHead>
              <TableHead>Number</TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {heldRow("Held at the start", period.from, opening, "history-opening")}
            {history.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                  No stock of this product moved in this period.
                </TableCell>
              </TableRow>
            )}
            {history.rows.map((row) => {
              const out = row.quantity.startsWith("-");
              return (
                <TableRow key={row.id} data-testid="history-row">
                  <TableCell className="whitespace-nowrap">{formatDateTime(row.at)}</TableCell>
                  <TableCell>{MOVEMENT_LABELS[row.type] ?? row.type}</TableCell>
                  <TableCell>{row.locationName}</TableCell>
                  <TableCell className={out ? "text-right text-destructive tabular-nums" : "text-right text-emerald-700 tabular-nums dark:text-emerald-400"}>
                    {signedNumber(row.quantity)}
                    {/* As it was entered, when that was not in the smallest unit: "2 carton". */}
                    {!row.entered.endsWith(` ${unit}`) && <span className="block text-xs text-muted-foreground">{plainNumber(row.entered.split(" ")[0].replace("-", ""))} {row.entered.split(" ").slice(1).join(" ")}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{plainNumber(row.leftThere)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{plainNumber(row.leftInAll)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {row.documentHref ? (
                      <Link href={row.documentHref} className="text-link underline-offset-4 hover:underline">
                        {row.documentNumber}
                      </Link>
                    ) : (
                      row.documentNumber
                    )}
                  </TableCell>
                  <TableCell>{row.userName}</TableCell>
                </TableRow>
              );
            })}
            {history.more === 0 && heldRow("Held at the end", period.to, closing, "history-closing")}
          </TableBody>
        </Table>
        {history.more > 0 && (
          <p className="text-sm text-destructive" data-testid="history-more">
            Only the first {history.rows.length.toLocaleString("en-NG")} movements of this period are shown; {history.more.toLocaleString("en-NG")} more followed. Choose a
            shorter period to see them. At the end of the period {plainNumber(closing.total)} {unit} was held.
          </p>
        )}
        <p className="text-xs text-muted-foreground">Quantities are in {unit}. “Left there” is what that place held straight after the movement; “Left in all” is every place together.</p>
      </CardContent>
    </Card>
  );
}
