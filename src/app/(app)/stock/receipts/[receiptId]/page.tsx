import { ArrowLeft, ClipboardList, History, PencilLine } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatDay, nairaFromText, plainNumber, receiptNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getReceiptHistory, type ReceiptVersionView } from "@/server/business/receipt-corrections";
import { getReceipt } from "@/server/business/stock";
import { NotFoundError, ValidationError } from "@/server/errors";
import { can } from "@/server/permissions";

export const metadata: Metadata = { title: "Delivery — KuchPos" };

export default async function ReceiptPage({ params }: PageProps<"/stock/receipts/[receiptId]">) {
  const context = await requirePagePermission("stock.receipts.view");
  const { receiptId } = await params;

  let receipt: Awaited<ReturnType<typeof getReceipt>>;
  let history: ReceiptVersionView[];
  try {
    receipt = await getReceipt(context, { receiptId });
    history = await getReceiptHistory(context, { receiptId });
  } catch (error) {
    // A delivery of another business, or a made-up address, looks exactly like one that does not exist.
    if (error instanceof NotFoundError || error instanceof ValidationError) notFound();
    throw error;
  }
  const hasBatch = receipt.lines.some((line) => line.batchNumber);
  const hasExpiry = receipt.lines.some((line) => line.expiryDate);

  const corrections = history.filter((version) => version.version > 1).reverse();
  const original = history.find((version) => version.version === 1);
  const lastCorrection = corrections[0];

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
            {receipt.version > 1 && <Badge variant="secondary">Corrected</Badge>}
          </span>
        }
        description={
          receipt.version > 1
            ? "This is the delivery as corrected. The original and every correction are kept below."
            : "A mistake can be corrected by a manager or admin. The original always stays on record."
        }
      >
        {can(context, "stock.receipt.correct") && (
          <Link href={`/stock/receipts/${receipt.id}/correct`} className={buttonVariants({ variant: "outline" })}>
            <PencilLine className="size-4" aria-hidden /> Correct this delivery
          </Link>
        )}
      </PageHeader>

      {lastCorrection && (
        <Alert data-testid="corrected-notice">
          Corrected {corrections.length === 1 ? "once" : `${corrections.length} times`}, last by {lastCorrection.savedByName}{" "}
          on {formatDateTime(lastCorrection.savedAt)}. Reason given: {lastCorrection.reason}{" "}
          <a href="#history" className="text-link underline-offset-4 hover:underline">
            See what changed
          </a>
        </Alert>
      )}

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

      {corrections.length > 0 && (
        <section id="history" className="flex scroll-mt-24 flex-col gap-4" data-testid="correction-history">
          <h2 className="flex items-center gap-2 px-1 pt-2 text-lg font-semibold">
            <History className="size-4.5 text-link" aria-hidden /> Correction history
          </h2>
          <p className="-mt-2 px-1 text-sm text-muted-foreground">
            Newest first. Nothing here can be changed or removed.
          </p>

          {corrections.map((version) => (
            <Card key={version.version} data-testid={`correction-${version.version - 1}`}>
              <CardContent className="flex flex-col gap-3">
                <div>
                  <p className="font-medium">
                    Correction {version.version - 1} — {version.savedByName}, {formatDateTime(version.savedAt)}
                  </p>
                  <p className="text-sm">Reason: {version.reason}</p>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>What</TableHead>
                      <TableHead>Was</TableHead>
                      <TableHead>Changed to</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {version.changes.map((change, index) => (
                      <TableRow key={index}>
                        <TableCell className="font-medium">
                          {change.label}
                          {change.productName && <span className="font-normal text-muted-foreground"> · {change.productName}</span>}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{change.oldValue ?? "—"}</TableCell>
                        <TableCell>{change.newValue ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="text-sm text-muted-foreground" data-testid={`correction-${version.version - 1}-stock`}>
                  {version.stockEffects.length === 0
                    ? "Stock was not affected."
                    : `Stock adjusted: ${version.stockEffects
                        .map(
                          (effect) =>
                            `${effect.quantity.startsWith("-") ? "−" : "+"}${plainNumber(effect.quantity.replace("-", ""))} ${effect.unitName} of ${effect.productName} in ${effect.locationName}`,
                        )
                        .join("; ")}.`}
                </p>
              </CardContent>
            </Card>
          ))}

          {original && (
            <Card data-testid="original-delivery">
              <CardContent className="flex flex-col gap-3">
                <div>
                  <p className="font-medium">
                    As first entered — {original.savedByName}, {formatDateTime(original.savedAt)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {original.supplierName} · into {original.locationName} · received {formatDay(original.receivedOn)}
                    {original.invoiceNumber ? ` · invoice ${original.invoiceNumber}` : ""}
                    {original.note ? ` · note: ${original.note}` : ""}
                  </p>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Arrived</TableHead>
                      <TableHead>Batch</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead className="text-right">Cost each</TableHead>
                      <TableHead className="text-right">Line cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {original.lines.map((line) => (
                      <TableRow key={line.lineNumber}>
                        <TableCell className="font-medium">{line.productName}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {plainNumber(line.quantity)} {line.unitName}
                        </TableCell>
                        <TableCell>{line.batchNumber ?? "—"}</TableCell>
                        <TableCell className="whitespace-nowrap">{line.expiryDate ? formatDay(line.expiryDate) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{nairaFromText(line.unitCost)}</TableCell>
                        <TableCell className="text-right tabular-nums">{nairaFromText(line.lineCost)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="text-right text-sm text-muted-foreground">
                  Total cost as first entered{" "}
                  <span className="ml-2 font-semibold text-foreground tabular-nums">{nairaFromText(original.totalCost)}</span>
                </p>
              </CardContent>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}
