import { ArrowLeft, ArrowLeftRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime, plainNumber, transferNumber } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { getTransfer } from "@/server/business/transfers";
import { NotFoundError, ValidationError } from "@/server/errors";

export const metadata: Metadata = { title: "Transfer — KuchPos" };

export default async function TransferPage({ params }: PageProps<"/stock/transfers/[transferId]">) {
  const context = await requirePagePermission("report.stock.view");
  const { transferId } = await params;

  let transfer: Awaited<ReturnType<typeof getTransfer>>;
  try {
    transfer = await getTransfer(context, { transferId });
  } catch (error) {
    // A transfer of another business, or a made-up address, looks exactly like one that does not exist.
    if (error instanceof NotFoundError || error instanceof ValidationError) notFound();
    throw error;
  }

  const facts: [string, string][] = [
    ["Moved from", transfer.fromLocationName],
    ["Moved to", transfer.toLocationName],
    ["Moved by", transfer.createdByName],
    ["When", formatDateTime(transfer.createdAt)],
  ];

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <Link href="/stock/transfers" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Transfers
      </Link>
      <PageHeader
        icon={ArrowLeftRight}
        title={`Transfer ${transferNumber(transfer.number)}`}
        description="A saved transfer cannot be changed. If it was a mistake, move the stock back with a new transfer."
      />

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
          {transfer.note && <p className="mt-4 border-t pt-4 text-sm">Note: {transfer.note}</p>}
        </CardContent>
      </Card>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Moved</TableHead>
            <TableHead className="text-right">In base units</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transfer.lines.map((line) => (
            <TableRow key={line.lineNumber} data-testid={`transfer-line-${line.lineNumber}`}>
              <TableCell className="font-medium">{line.productName}</TableCell>
              <TableCell className="text-right tabular-nums">
                {plainNumber(line.quantity)} {line.unitName}
              </TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{plainNumber(line.baseQuantity)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
