import { ArrowLeft, Scale } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { reasonLabel } from "@/lib/adjustment-reasons";
import { Decimal } from "@/lib/decimal";
import { adjustmentNumber, countNumber, formatDateTime, plainNumber, signedNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getAdjustment } from "@/server/business/adjustments";
import { NotFoundError, ValidationError } from "@/server/errors";
import { StatusBadge } from "../status-badge";
import { DecisionForm } from "./decision-form";

export const metadata: Metadata = { title: "Stock adjustment — KuchPos" };

export default async function AdjustmentPage({ params }: PageProps<"/stock/adjustments/[adjustmentId]">) {
  const context = await requirePagePermission("report.stock.view");
  const { adjustmentId } = await params;

  let adjustment: Awaited<ReturnType<typeof getAdjustment>>;
  try {
    adjustment = await getAdjustment(context, { adjustmentId });
  } catch (error) {
    // An adjustment of another business, or a made-up address, looks exactly like one that does not exist.
    if (error instanceof NotFoundError || error instanceof ValidationError) notFound();
    throw error;
  }
  const waiting = adjustment.status === "PENDING";

  const facts: [string, string][] = [
    ["Location", adjustment.locationName],
    ["Entered by", adjustment.createdByName],
    ["Entered on", formatDateTime(adjustment.createdAt)],
    [
      adjustment.status === "REJECTED" ? "Rejected by" : "Approved by",
      adjustment.decidedByName ? `${adjustment.decidedByName}, ${formatDateTime(adjustment.decidedAt!)}` : "Nobody yet",
    ],
  ];

  // While it waits: what each product's stock would be afterwards, adding up its lines.
  const netOf = new Map<string, Decimal>();
  for (const line of adjustment.lines) {
    netOf.set(line.productId, (netOf.get(line.productId) ?? new Decimal(0)).plus(line.baseQuantity));
  }

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <Link href="/stock/adjustments" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Stock adjustments
      </Link>
      <PageHeader
        icon={Scale}
        title={
          <span className="flex flex-wrap items-center gap-2">
            Adjustment {adjustmentNumber(adjustment.number)} <StatusBadge status={adjustment.status} />
          </span>
        }
        description={
          waiting
            ? "Stock has not changed. It changes only if a manager or admin approves this."
            : adjustment.status === "APPLIED"
              ? "Stock was changed by the amounts below. A saved adjustment cannot be altered; a mistake is put right with a new one."
              : "This was rejected, so stock was not changed."
        }
      />

      {adjustment.count && (
        <Alert>
          These are the differences found by stock count{" "}
          <Link href={`/stock/counts/${adjustment.count.id}`} className="font-medium text-link underline-offset-4 hover:underline">
            {countNumber(adjustment.count.number)}
          </Link>
          .
        </Alert>
      )}

      <Card>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {adjustment.note && <p className="mt-4 border-t pt-4 text-sm">Note: {adjustment.note}</p>}
          {adjustment.decisionNote && (
            <p className="mt-4 border-t pt-4 text-sm" data-testid="decision-note">
              {adjustment.status === "REJECTED" ? "Reason for rejecting" : "Approver's note"}: {adjustment.decisionNote}
            </p>
          )}
        </CardContent>
      </Card>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Change</TableHead>
            <TableHead className="text-right">In base units</TableHead>
            <TableHead>Reason</TableHead>
            {waiting && <TableHead className="text-right">In {adjustment.locationName} now</TableHead>}
            {waiting && <TableHead className="text-right">After approval</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {adjustment.lines.map((line) => {
            const after = line.stockNow === null ? null : new Decimal(line.stockNow).plus(netOf.get(line.productId) ?? 0);
            return (
              <TableRow key={line.lineNumber} data-testid={`adjustment-line-${line.lineNumber}`}>
                <TableCell className="font-medium">{line.productName}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {signedNumber(line.quantity)} {line.unitName}
                </TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">
                  {signedNumber(line.baseQuantity)} {line.baseUnitName}
                </TableCell>
                <TableCell>{reasonLabel(line.reason)}</TableCell>
                {waiting && <TableCell className="text-right tabular-nums">{plainNumber(line.stockNow ?? "0")}</TableCell>}
                {waiting && (
                  <TableCell className={after?.isNegative() ? "text-right font-semibold text-destructive tabular-nums" : "text-right tabular-nums"}>
                    {after === null ? "—" : after.isNegative() ? "Not enough stock" : plainNumber(after.toFixed(3))}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {adjustment.canDecide && <DecisionForm adjustmentId={adjustment.id} />}
    </div>
  );
}
