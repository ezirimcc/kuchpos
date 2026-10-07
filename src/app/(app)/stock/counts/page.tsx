import { ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FilterDate, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ADJUSTMENT_STATUS_LABELS } from "@/lib/adjustment-reasons";
import { adjustmentNumber, countNumber, formatDateTime } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listCounts } from "@/server/business/counts";
import { StockTabs } from "../stock-tabs";

export const metadata: Metadata = { title: "Stock counts — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function CountsPage({ searchParams }: PageProps<"/stock/counts">) {
  const context = await requirePagePermission("report.stock.view");
  const params = await searchParams;
  const filters = { q: text(params.q), from: text(params.from), to: text(params.to) };
  const list = await listCounts(context, { search: filters.q, from: filters.from, to: filters.to, page: text(params.page) });
  const filtered = Object.values(filters).some((value) => value !== "");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={ClipboardCheck}
        title="Stock counts"
        description="What was physically counted, set against what the system expected. A saved count is never changed."
      >
        {list.canCount && (
          <Link href="/stock/counts/new" className={buttonVariants()}>
            <ClipboardCheck className="size-4" aria-hidden /> New count
          </Link>
        )}
      </PageHeader>
      <StockTabs context={context} current="counts" />

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search counts" placeholder="Product, person or count number" />
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
          {filtered && (
            <Link href="/stock/counts" className="text-sm text-link underline-offset-4 hover:underline">
              Clear filters
            </Link>
          )}
        </div>
      </Suspense>

      {list.counts.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtered ? "No count matches these filters." : "No stock has been counted yet."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Count</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Where</TableHead>
              <TableHead className="text-right">Products</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Adjustment</TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.counts.map((count) => (
              <TableRow key={count.id} data-testid={`count-row-${count.number}`}>
                <TableCell className="font-medium">
                  <Link href={`/stock/counts/${count.id}`} className="text-link underline-offset-4 hover:underline">
                    {countNumber(count.number)}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDateTime(count.createdAt)}</TableCell>
                <TableCell>
                  {count.locationName}
                  {count.categoryName && <span className="text-muted-foreground"> · {count.categoryName}</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{count.productCount}</TableCell>
                <TableCell>
                  {count.differences === 0 ? (
                    <Badge variant="success">All matched</Badge>
                  ) : (
                    <Badge variant="destructive">{count.differences} did not match</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {count.adjustment ? (
                    <Link href={`/stock/adjustments/${count.adjustment.id}`} className="text-link underline-offset-4 hover:underline">
                      {adjustmentNumber(count.adjustment.number)} · {ADJUSTMENT_STATUS_LABELS[count.adjustment.status].toLowerCase()}
                    </Link>
                  ) : count.differences > 0 ? (
                    <span className="text-muted-foreground">Not yet recorded</span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{count.createdByName}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination path="/stock/counts" params={filters} noun="counts" {...list} />
    </div>
  );
}
