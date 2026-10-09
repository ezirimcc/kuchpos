import { ArrowLeft, CloudOff } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FilterDate, FilterSelect } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listOfflineExceptions } from "@/server/business/offline";
import { ReviewForm } from "./review-form";

export const metadata: Metadata = { title: "Offline exceptions — KuchPos" };

const KIND_LABELS: Record<string, string> = {
  STOCK_SHORT: "More sold than the system held",
  PRICE_DIFFERENT: "Price not the current one",
  OUT_OF_USE: "Something taken out of use",
  TIME: "Time or clock",
  ACCOUNT: "Cashier's account",
  RECEIPT_NUMBER: "Receipt number changed",
};

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function OfflineExceptionsPage({ searchParams }: PageProps<"/sales/offline">) {
  const context = await requirePagePermission("report.sales.view");
  const params = await searchParams;
  const filters = { kind: text(params.kind), status: text(params.status), from: text(params.from), to: text(params.to) };
  const list = await listOfflineExceptions(context, {
    kind: filters.kind,
    status: filters.status === "open" || filters.status === "done" ? filters.status : "",
    from: filters.from,
    to: filters.to,
    page: text(params.page),
  });
  const filtered = Object.values(filters).some((value) => value !== "");

  return (
    <div className="flex flex-col gap-5">
      <Link href="/sales" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Sales
      </Link>
      <PageHeader
        icon={CloudOff}
        title="Offline exceptions"
        description="Sales made without internet are always accepted, because the goods have already left the shop. Anything out of the ordinary about one is listed here for a manager to look at — most often a product that sold more than the system held, which means it should be counted."
      />

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect
            name="status"
            label="Looked at or not"
            allLabel="All"
            options={[
              { value: "open", label: "Not looked at yet" },
              { value: "done", label: "Looked at" },
            ]}
          />
          <FilterSelect name="kind" label="Kind" allLabel="Every kind" options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))} />
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
          {filtered && (
            <Link href="/sales/offline" className="text-sm text-link underline-offset-4 hover:underline">
              Clear filters
            </Link>
          )}
        </div>
      </Suspense>

      <p className="text-sm text-muted-foreground" data-testid="exceptions-waiting">
        {list.waiting === 0 ? "Nothing is waiting to be looked at." : list.waiting === 1 ? "1 is waiting to be looked at." : `${list.waiting} are waiting to be looked at.`}
      </p>

      {list.rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtered ? "Nothing matches these filters." : "No sale made without internet has needed a second look."}
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sale</TableHead>
                <TableHead>Sold</TableHead>
                <TableHead>Cashier</TableHead>
                <TableHead>What was found</TableHead>
                <TableHead>Looked at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((row) => (
                <TableRow key={row.id} data-testid="exception-row">
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/sales/${row.sale.id}`} className="text-link underline-offset-4 hover:underline">
                      {row.sale.receiptNumber}
                    </Link>
                    {row.sale.cancelled && (
                      <Badge variant="destructive" className="ml-2">
                        Cancelled
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(row.sale.soldAt)}</TableCell>
                  <TableCell>{row.sale.cashierName}</TableCell>
                  <TableCell>
                    <span className="block text-xs font-medium text-muted-foreground">{KIND_LABELS[row.kind]}</span>
                    {row.summary}
                  </TableCell>
                  <TableCell>
                    {row.review ? (
                      <>
                        {row.review.reviewedByName}, {formatDateTime(row.review.at)}
                        {row.review.note && <span className="block text-xs text-muted-foreground">{row.review.note}</span>}
                      </>
                    ) : list.canReview ? (
                      <ReviewForm exceptionId={row.id} />
                    ) : (
                      <span className="text-muted-foreground">Not yet</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination path="/sales/offline" params={filters} noun="entries" page={list.page} pageCount={list.pageCount} total={list.total} pageSize={list.pageSize} />
        </>
      )}
    </div>
  );
}
