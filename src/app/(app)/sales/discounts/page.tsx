import { ArrowLeft, BadgePercent } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FilterDate, FilterSelect, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, nairaFromText } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listApprovals } from "@/server/business/approvals";

export const metadata: Metadata = { title: "Discounts and approvals — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function DiscountsPage({ searchParams }: PageProps<"/sales/discounts">) {
  const context = await requirePagePermission("report.discounts.view");
  const params = await searchParams;
  const filters = { q: text(params.q), kind: text(params.kind), from: text(params.from), to: text(params.to) };
  const list = await listApprovals(context, {
    search: filters.q,
    kind: filters.kind === "DISCOUNT" || filters.kind === "CREDIT_OVER_LIMIT" ? filters.kind : "",
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
        icon={BadgePercent}
        title="Discounts and approvals"
        description="Every extra discount, and every time a customer was let over their credit limit: who asked, who approved, why, how much and when. Nothing here can be changed."
      />

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search approvals" placeholder="Cashier, approver, reason or receipt number" />
          <FilterSelect
            name="kind"
            label="Kind"
            allLabel="Discounts and credit"
            options={[
              { value: "DISCOUNT", label: "Discounts" },
              { value: "CREDIT_OVER_LIMIT", label: "Credit over the limit" },
            ]}
          />
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
          {filtered && (
            <Link href="/sales/discounts" className="text-sm text-link underline-offset-4 hover:underline">
              Clear filters
            </Link>
          )}
        </div>
      </Suspense>

      {list.rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtered ? "Nothing matches these filters." : "No discount has been given yet."}
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When approved</TableHead>
                <TableHead>What</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Asked by</TableHead>
                <TableHead>Approved by</TableHead>
                <TableHead>Sale</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.rows.map((row) => (
                <TableRow key={row.id} data-testid="approval-row">
                  <TableCell className="whitespace-nowrap">{formatDateTime(row.approvedAt)}</TableCell>
                  <TableCell>
                    {row.kind === "DISCOUNT" ? "Discount" : "Credit over the limit"}
                    <span className="block text-xs text-muted-foreground">
                      {row.kind === "DISCOUNT" ? `on a sale of ${nairaFromText(row.basis)}` : `owing ${nairaFromText(row.basis)} afterwards`}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{nairaFromText(row.amount)}</TableCell>
                  <TableCell>{row.reason ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>{row.requestedByName}</TableCell>
                  <TableCell>
                    {row.approvedByName}
                    {row.ownSale && <span className="block text-xs text-muted-foreground">their own sale</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {row.sale ? (
                      <>
                        {list.canOpenSales ? (
                          <Link href={`/sales/${row.sale.id}`} className="text-link underline-offset-4 hover:underline">
                            {row.sale.receiptNumber}
                          </Link>
                        ) : (
                          row.sale.receiptNumber
                        )}
                        {row.sale.cancelled && (
                          <Badge variant="destructive" className="ml-2">
                            Cancelled
                          </Badge>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">{row.expired ? "Not used — ran out" : "Not used yet"}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="px-2 text-right text-sm text-muted-foreground">
            Discounts given on {list.discountCount} {list.discountCount === 1 ? "sale" : "sales"}
            {filtered ? " that match" : ""}, leaving out cancelled ones{" "}
            <span className="ml-2 text-2xl font-semibold text-foreground tabular-nums" data-testid="discounts-sum">
              {nairaFromText(list.discountTotal)}
            </span>
          </p>
          <Pagination path="/sales/discounts" params={filters} noun="approvals" page={list.page} pageCount={list.pageCount} total={list.total} pageSize={list.pageSize} />
        </>
      )}
    </div>
  );
}
