import { ArrowLeft, ReceiptText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Decimal } from "@/lib/decimal";
import { formatDateTime, nairaFromText, plainNumber } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { requirePageContext } from "@/server/auth/request";
import { getSale } from "@/server/business/sales";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { can } from "@/server/permissions";
import { CancelSaleForm } from "./cancel-sale-form";
import { ReceiptWithActions } from "./receipt-actions";

export const metadata: Metadata = { title: "Sale — KuchPos" };

export default async function SalePage({ params, searchParams }: PageProps<"/sales/[saleId]">) {
  const context = await requirePageContext();
  const { saleId } = await params;
  const justSold = (await searchParams).sold === "1";

  let sale: Awaited<ReturnType<typeof getSale>>;
  try {
    sale = await getSale(context, { saleId });
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/");
    // Someone else's sale (for a cashier), another business's, or a made-up address: all "not found".
    if (error instanceof NotFoundError || error instanceof ValidationError) notFound();
    throw error;
  }
  const showsStoreroom = sale.lines.some((line) => line.locationName !== sale.lines[0].locationName) || sale.lines[0]?.locationName !== "Shelf";

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <Link href="/sales" className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline">
        <ArrowLeft className="size-3.5" aria-hidden /> Sales
      </Link>
      <PageHeader
        icon={ReceiptText}
        title={
          <span className="flex flex-wrap items-center gap-2">
            Sale {sale.receiptNumber}
            {sale.cancellation && <Badge variant="destructive">Cancelled</Badge>}
          </span>
        }
        description={
          <>
            {formatDateTime(sale.createdAt)} · served by {sale.cashierName}
            {sale.customer && (
              <>
                {" "}
                · sold to{" "}
                {can(context, "customer.balance.view") ? (
                  <Link href={`/customers/${sale.customer.id}`} className="text-link underline-offset-4 hover:underline">
                    {sale.customer.name}
                  </Link>
                ) : (
                  sale.customer.name
                )}
              </>
            )}{" "}
            · a saved sale is never changed.
          </>
        }
      />

      {sale.cancellation && (
        <Alert variant="destructive" data-testid="cancelled-notice">
          Cancelled by {sale.cancellation.cancelledByName} on {formatDateTime(sale.cancellation.createdAt)}. The goods went
          back into stock and the payment was refunded. Reason given: {sale.cancellation.note}
        </Alert>
      )}

      {sale.discountAmount !== "0.00" && (
        <Alert data-testid="discount-notice">
          A discount of {nairaFromText(sale.discountAmount)}
          {sale.discountPercent ? ` (${plainNumber(sale.discountPercent)}%)` : ""} was taken off {nairaFromText(sale.subtotal)}
          {sale.discountApprovedBy ? `, approved by ${sale.discountApprovedBy}` : ""}. Reason given: {sale.discountReason}
        </Alert>
      )}

      <ReceiptWithActions sale={sale} justSold={justSold} canSell={can(context, "sale.create")} />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead className="text-right">Sold</TableHead>
            <TableHead className="text-right">In base units</TableHead>
            {showsStoreroom && <TableHead>Taken from</TableHead>}
            <TableHead className="text-right">Price each</TableHead>
            <TableHead className="text-right">Line total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sale.lines.map((line) => (
            <TableRow key={line.lineNumber} data-testid={`sale-line-${line.lineNumber}`}>
              <TableCell className="font-medium">{line.productName}</TableCell>
              <TableCell className="text-right tabular-nums">
                {plainNumber(line.quantity)} {line.unitName}
              </TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{plainNumber(line.baseQuantity)}</TableCell>
              {showsStoreroom && <TableCell>{line.locationName}</TableCell>}
              <TableCell className="text-right tabular-nums">{nairaFromText(line.unitPrice)}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">{nairaFromText(line.lineTotal)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {sale.canCancel && <CancelSaleForm saleId={sale.id} refunds={sale.payments.map((payment) => ({ methodName: payment.methodName, amount: payment.amount }))} />}

      {sale.costTotal !== null && !sale.cancellation && (
        <p className="px-2 text-right text-sm text-muted-foreground" data-testid="sale-profit">
          Cost of these goods {nairaFromText(sale.costTotal)} · profit{" "}
          <span className="font-semibold text-foreground">{formatNaira(new Decimal(sale.total).minus(sale.costTotal))}</span>
        </p>
      )}
    </div>
  );
}
