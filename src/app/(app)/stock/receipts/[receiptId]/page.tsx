import { ArrowLeft, ClipboardList } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatDay, nairaFromText, plainNumber, receiptNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getReceipt } from "@/server/business/stock";
import { NotFoundError, ValidationError } from "@/server/errors";

export const metadata: Metadata = { title: "Delivery — KuchPos" };

export default async function ReceiptPage({ params }: PageProps<"/stock/receipts/[receiptId]">) {
  const context = await requirePagePermission("stock.receipts.view");
  const { receiptId } = await params;

  let receipt: Awaited<ReturnType<typeof getReceipt>>;
  try {
    receipt = await getReceipt(context, { receiptId });
  } catch (error) {
    // A delivery of another business, or a made-up address, looks exactly like one that does not exist.
    if (error instanceof NotFoundError || error instanceof ValidationError) notFound();
    throw error;
  }
  const hasBatch = receipt.lines.some((line) => line.batchNumber);
  const hasExpiry = receipt.lines.some((line) => line.expiryDate);

  const facts: [string, string][] = [
    ["Supplier", receipt.supplierName],
    ["Went into", receipt.locationName],
    ["Date received", formatDay(receipt.receivedOn)],
    ["Supplier's invoice", receipt.invoiceNumber ?? "—"],
    ["Entered by", receipt.createdByName],
    ["Entered on", formatDateTime(receipt.createdAt)],
  ];

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <Link href="/stock/receipts" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Deliveries
      </Link>
      <PageHeader
        icon={ClipboardList}
        title={
          <span className="flex flex-wrap items-center gap-2">
            Delivery {receiptNumber(receipt.number)}
            {receipt.backdated && <Badge variant="destructive">Backdated</Badge>}
          </span>
        }
        description="A saved delivery cannot be changed. A mistake is corrected with a stock adjustment."
      />

      {receipt.backdated && (
        <Alert variant="destructive" data-testid="backdate-notice">
          Entered on {formatDateTime(receipt.createdAt)} with the earlier date {formatDay(receipt.receivedOn)}. Reason
          given: {receipt.backdateNote}
        </Alert>
      )}

      <Card>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {receipt.note && <p className="mt-4 border-t pt-4 text-sm">Note: {receipt.note}</p>}
        </CardContent>
      </Card>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Arrived</TableHead>
            <TableHead className="text-right">In base units</TableHead>
            {hasBatch && <TableHead>Batch</TableHead>}
            {hasExpiry && <TableHead>Expires</TableHead>}
            <TableHead className="text-right">Cost each</TableHead>
            <TableHead className="text-right">Line cost</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {receipt.lines.map((line) => (
            <TableRow key={line.lineNumber} data-testid={`receipt-line-${line.lineNumber}`}>
              <TableCell className="font-medium">{line.productName}</TableCell>
              <TableCell className="text-right tabular-nums">
                {plainNumber(line.quantity)} {line.unitName}
              </TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{plainNumber(line.baseQuantity)}</TableCell>
              {hasBatch && <TableCell>{line.batchNumber ?? "—"}</TableCell>}
              {hasExpiry && <TableCell className="whitespace-nowrap">{line.expiryDate ? formatDay(line.expiryDate) : "—"}</TableCell>}
              <TableCell className="text-right tabular-nums">{nairaFromText(line.unitCost)}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{nairaFromText(line.lineCost)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <p className="px-2 text-right text-sm text-muted-foreground">
        Total cost{" "}
        <span className="ml-2 text-2xl font-semibold text-foreground tabular-nums" data-testid="receipt-total">
          {nairaFromText(receipt.totalCost)}
        </span>
      </p>
    </div>
  );
}
