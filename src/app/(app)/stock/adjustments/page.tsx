import { Scale } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FilterDate, FilterSelect, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adjustmentNumber, countNumber, formatDateTime } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listAdjustments } from "@/server/business/adjustments";
import { StockTabs } from "../stock-tabs";
import { StatusBadge } from "./status-badge";

export const metadata: Metadata = { title: "Stock adjustments — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function AdjustmentsPage({ searchParams }: PageProps<"/stock/adjustments">) {
  const context = await requirePagePermission("report.stock.view");
  const params = await searchParams;
  const filters = { q: text(params.q), status: text(params.status), from: text(params.from), to: text(params.to) };
  const list = await listAdjustments(context, {
    search: filters.q,
    status: filters.status,
    from: filters.from,
    to: filters.to,
    page: text(params.page),
  });
  const filtered = Object.values(filters).some((value) => value !== "");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={Scale}
        title="Stock adjustments"
        description="Stock added or taken out with a reason: damage, expiry, loss, counting differences. A storekeeper's adjustment waits for approval."
      >
        {list.canRecord && (
          <Link href="/stock/adjustments/new" className={buttonVariants()}>
            <Scale className="size-4" aria-hidden /> New adjustment
          </Link>
        )}
      </PageHeader>
      <StockTabs context={context} current="adjustments" />

      {list.waiting > 0 && filters.status !== "pending" && (
        <Alert data-testid="waiting-notice">
          {list.waiting === 1 ? "1 adjustment is" : `${list.waiting} adjustments are`} waiting for approval
          {list.canDecide ? "." : " by a manager or admin."}{" "}
          <Link href="/stock/adjustments?status=pending" className="font-medium text-link underline-offset-4 hover:underline">
            Show {list.waiting === 1 ? "it" : "them"}
          </Link>
        </Alert>
      )}

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search adjustments" placeholder="Product, person or adjustment number" />
          <FilterSelect
            name="status"
            label="Filter by status"
            allLabel="Any status"
            options={[
              { value: "pending", label: "Waiting for approval" },
              { value: "applied", label: "Applied" },
              { value: "rejected", label: "Rejected" },
            ]}
          />
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
          {filtered && (
            <Link href="/stock/adjustments" className="text-sm text-link underline-offset-4 hover:underline">
              Clear filters
            </Link>
          )}
        </div>
      </Suspense>

      {list.adjustments.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtered ? "No adjustment matches these filters." : "No stock adjustments have been recorded yet."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Adjustment</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Where</TableHead>
              <TableHead>Products</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Entered by</TableHead>
              <TableHead>Decided by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.adjustments.map((adjustment) => (
              <TableRow key={adjustment.id} data-testid={`adjustment-row-${adjustment.number}`}>
                <TableCell className="font-medium whitespace-nowrap">
                  <Link href={`/stock/adjustments/${adjustment.id}`} className="text-link underline-offset-4 hover:underline">
                    {adjustmentNumber(adjustment.number)}
                  </Link>
                  {adjustment.countNumber !== null && (
                    <span className="font-normal text-muted-foreground"> · from {countNumber(adjustment.countNumber)}</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDateTime(adjustment.createdAt)}</TableCell>
                <TableCell>{adjustment.locationName}</TableCell>
                <TableCell>
                  {adjustment.products.join(", ")}
                  {adjustment.lineCount > adjustment.products.length && (
                    <span className="text-muted-foreground"> and {adjustment.lineCount - adjustment.products.length} more</span>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={adjustment.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">{adjustment.createdByName}</TableCell>
                <TableCell className="text-muted-foreground">{adjustment.decidedByName ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Pagination path="/stock/adjustments" params={filters} noun="adjustments" {...list} />
    </div>
  );
}
