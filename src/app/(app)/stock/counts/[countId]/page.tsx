import { ArrowLeft, ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ADJUSTMENT_STATUS_LABELS } from "@/lib/adjustment-reasons";
import { adjustmentNumber, countNumber, formatDateTime, plainNumber, signedNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getCount } from "@/server/business/counts";
import { NotFoundError, ValidationError } from "@/server/errors";
import { CountAdjustForm } from "./count-adjust-form";

export const metadata: Metadata = { title: "Stock count — KuchPos" };

export default async function CountPage({ params }: PageProps<"/stock/counts/[countId]">) {
  const context = await requirePagePermission("report.stock.view");
  const { countId } = await params;

  let count: Awaited<ReturnType<typeof getCount>>;
  try {
    count = await getCount(context, { countId });
  } catch (error) {
    // A count of another business, or a made-up address, looks exactly like one that does not exist.
    if (error instanceof NotFoundError || error instanceof ValidationError) notFound();
    throw error;
  }

  const facts: [string, string][] = [
    ["Counted in", count.locationName + (count.categoryName ? ` · ${count.categoryName}` : "")],
    ["Counted by", count.createdByName],
    ["Saved on", formatDateTime(count.createdAt)],
    ["Products counted", String(count.productCount)],
  ];
  const differences = count.lines.filter((line) => line.difference !== "0.000");

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <Link href="/stock/counts" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Stock counts
      </Link>
      <PageHeader
        icon={ClipboardCheck}
        title={
          <span className="flex flex-wrap items-center gap-2">
            Count {countNumber(count.number)}
            {count.differences === 0 ? (
              <Badge variant="success">All matched</Badge>
            ) : (
              <Badge variant="destructive">{count.differences} did not match</Badge>
            )}
          </span>
        }
        description="What was counted, against what the system held at the moment the count was saved. A count changes no stock by itself."
      />

      {count.adjustment && (
        <Alert data-testid="count-adjustment">
          The differences were recorded as adjustment{" "}
          <Link href={`/stock/adjustments/${count.adjustment.id}`} className="font-medium text-link underline-offset-4 hover:underline">
            {adjustmentNumber(count.adjustment.number)}
          </Link>{" "}
          — {ADJUSTMENT_STATUS_LABELS[count.adjustment.status].toLowerCase()}.
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
          {count.note && <p className="mt-4 border-t pt-4 text-sm">Note: {count.note}</p>}
        </CardContent>
      </Card>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead>Counted as</TableHead>
            <TableHead className="text-right">Counted</TableHead>
            <TableHead className="text-right">System expected</TableHead>
            <TableHead className="text-right">Difference</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {count.lines.map((line) => (
            <TableRow key={line.lineNumber} data-testid={`count-line-${line.lineNumber}`}>
              <TableCell className="font-medium">{line.productName}</TableCell>
              <TableCell className="text-muted-foreground">{line.enteredAs}</TableCell>
              <TableCell className="text-right tabular-nums">
                {plainNumber(line.counted)} {line.baseUnitName}
              </TableCell>
              <TableCell className="text-right tabular-nums">{plainNumber(line.expected)}</TableCell>
              <TableCell
                className={
                  line.difference === "0.000"
                    ? "text-right text-muted-foreground tabular-nums"
                    : "text-right font-semibold text-destructive tabular-nums"
                }
                data-testid={`count-difference-${line.lineNumber}`}
              >
                {signedNumber(line.difference)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {count.canAdjust && (
        <CountAdjustForm
          countId={count.id}
          appliesAtOnce={count.appliesAtOnce}
          locationName={count.locationName}
          differences={differences.map((line) => ({
            lineNumber: line.lineNumber,
            productName: line.productName,
            baseUnitName: line.baseUnitName,
            difference: line.difference,
          }))}
        />
      )}
      {!count.canAdjust && !count.adjustment && count.differences > 0 && (
        <p className="px-1 text-sm text-muted-foreground">
          No adjustment has been recorded for these differences yet. An admin, manager or storekeeper can record one.
        </p>
      )}
    </div>
  );
}
