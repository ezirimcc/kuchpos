import { ArrowLeft, Layers } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, formatDay, plainNumber, signedNumber } from "@/lib/format";
import { MOVEMENT_LABELS } from "@/lib/movement-labels";
import { requirePagePermission } from "@/server/auth/request";
import { getBatchHistory } from "@/server/business/stock";
import { NotFoundError, ValidationError } from "@/server/errors";

export const metadata: Metadata = { title: "Batch — KuchPos" };

/** One Storeroom batch: what is left of it, whether it is finished, and everything that happened to it (C78). */
export default async function BatchPage({ params }: PageProps<"/stock/batches/[batchId]">) {
  const context = await requirePagePermission("report.stock.view");
  const { batchId } = await params;

  let history: Awaited<ReturnType<typeof getBatchHistory>>;
  try {
    history = await getBatchHistory(context, { batchId });
  } catch (error) {
    // A batch of another business, or a made-up address, looks exactly like one that does not exist.
    if (error instanceof NotFoundError || error instanceof ValidationError) notFound();
    throw error;
  }
  const { batch, product } = history;
  const unit = product.baseUnitName;
  const finished = history.finishedAt !== null || history.left === "0.000";

  const facts: [string, string][] = [
    ["Product", product.name],
    ["Expires", batch.expiryDate ? formatDay(batch.expiryDate) : "No expiry date"],
    ["First came in", formatDay(batch.receivedOn)],
    [`Left in the ${history.storeroomName}`, `${plainNumber(history.left)} ${unit}`],
  ];

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <Link href={`/products/${product.id}#batches`} className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> {product.name}
      </Link>
      <PageHeader
        icon={Layers}
        title={`Batch ${batch.batchNumber ?? "with no number"}`}
        description={`Everything that has gone into and out of the ${history.storeroomName} from this batch. Goods on the Shelf are not counted by batch.`}
      />

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2" data-testid="batch-status">
            {finished ? (
              <Badge variant="secondary">Finished{history.finishedAt ? ` on ${formatDateTime(history.finishedAt)}` : ""}</Badge>
            ) : (
              <Badge variant="success">In the {history.storeroomName}</Badge>
            )}
            {batch.expired && <Badge variant="destructive">Expired</Badge>}
          </div>
          <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="border-t pt-4 text-sm text-muted-foreground">
            In all: {plainNumber(history.cameIn)} {unit} came in and {plainNumber(history.wentOut)} {unit} went out
            {history.heldBeforeRecording !== "0.000" && `, besides ${plainNumber(history.heldBeforeRecording)} ${unit} already there when batches began to be recorded`}.
          </p>
        </CardContent>
      </Card>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>What happened</TableHead>
            <TableHead className="text-right">In / out</TableHead>
            <TableHead className="text-right">Left in the batch</TableHead>
            <TableHead>Number</TableHead>
            <TableHead>By</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {history.heldBeforeRecording !== "0.000" && (
            <TableRow className="bg-muted/40">
              <TableCell colSpan={3} className="text-sm text-muted-foreground">
                Already in the {history.storeroomName} when batches began to be recorded
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">{plainNumber(history.heldBeforeRecording)}</TableCell>
              <TableCell colSpan={2} />
            </TableRow>
          )}
          {history.rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                Nothing of this batch has moved in or out of the {history.storeroomName}.
              </TableCell>
            </TableRow>
          )}
          {history.rows.map((row) => {
            const out = row.quantity.startsWith("-");
            return (
              <TableRow key={row.id} data-testid="batch-history-row">
                <TableCell className="whitespace-nowrap">{formatDateTime(row.at)}</TableCell>
                <TableCell>{MOVEMENT_LABELS[row.type] ?? row.type}</TableCell>
                <TableCell className={out ? "text-right text-destructive tabular-nums" : "text-right text-emerald-700 tabular-nums dark:text-emerald-400"}>
                  {signedNumber(row.quantity)} {unit}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">{plainNumber(row.leftInBatch)}</TableCell>
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
        </TableBody>
      </Table>
      {history.more > 0 && <p className="px-1 text-xs text-muted-foreground">The first {history.rows.length} movements are shown; {history.more} more are not.</p>}
    </div>
  );
}
