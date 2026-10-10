"use client";

import { Printer } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatDateTime, nairaFromText, plainNumber, returnNumber } from "@/lib/format";
import type { ReturnDetail } from "@/server/business/returns";

const PLACES = { SHELF: "back on the Shelf", STOREROOM: "back to the Storeroom", WRITTEN_OFF: "damaged — written off" } as const;

/**
 * The slip given to the customer for returned goods (C62), sized like a receipt, with its
 * Print button. Straight after the return is saved it prints by itself, if the business has
 * chosen automatic printing.
 */
export function ReturnSlip({ slip, justSaved }: { slip: ReturnDetail; justSaved: boolean }) {
  const started = useRef(false);
  useEffect(() => {
    if (!justSaved || !slip.business.autoPrintReceipts || started.current) return;
    started.current = true;
    window.print();
  }, [justSaved, slip.business.autoPrintReceipts]);

  const lines = (text: string | null) =>
    (text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  return (
    <div className="flex flex-wrap items-start gap-6">
      <div
        className="receipt-paper flex flex-col gap-1.5 rounded-md border bg-white p-2 leading-snug break-words text-black shadow-sm"
        data-width={slip.paperWidth}
        data-testid="return-slip"
      >
        <div className="text-center">
          <p className="text-[1.25em] font-bold">{slip.business.name}</p>
          {lines(slip.business.receiptHeader).map((line, index) => (
            <p key={index}>{line}</p>
          ))}
          {slip.business.taxNumber && <p>TIN: {slip.business.taxNumber}</p>}
        </div>
        <p className="border-y border-dashed border-black py-0.5 text-center font-bold tracking-widest">RETURN</p>
        <div>
          <p>Return: {returnNumber(slip.number)}</p>
          <p>For receipt: {slip.sale.receiptNumber}</p>
          <p>Date: {formatDateTime(slip.createdAt)}</p>
          <p>Taken back by: {slip.createdByName}</p>
          {slip.customerName && <p>Customer: {slip.customerName}</p>}
        </div>
        <div className="flex flex-col gap-1 border-t border-dashed border-black pt-1">
          {slip.lines.map((line) => (
            <div key={line.lineNumber} data-testid={`return-slip-item-${line.lineNumber}`}>
              <p className="font-semibold">{line.productName}</p>
              <p className="flex flex-wrap justify-between gap-x-2 tabular-nums">
                <span className="whitespace-nowrap">
                  {plainNumber(line.quantity)} {line.unitName} returned
                </span>
                <span className="ml-auto">{nairaFromText(line.refundAmount)}</span>
              </p>
            </div>
          ))}
        </div>
        <div className="border-t border-dashed border-black pt-1 tabular-nums">
          <p className="flex justify-between gap-2 text-[1.25em] font-bold">
            <span>REFUND</span>
            <span data-testid="return-slip-total">{nairaFromText(slip.refundTotal)}</span>
          </p>
          {slip.debtReduced !== "0.00" && (
            <p className="flex flex-wrap justify-between gap-x-2" data-testid="return-slip-debt">
              <span>Taken off your account</span>
              <span className="ml-auto">{nairaFromText(slip.debtReduced)}</span>
            </p>
          )}
          {slip.refundPaid !== "0.00" && (
            <p className="flex flex-wrap justify-between gap-x-2" data-testid="return-slip-paid">
              <span>Paid back: {slip.refundMethodName}</span>
              <span className="ml-auto">{nairaFromText(slip.refundPaid)}</span>
            </p>
          )}
          {slip.refundReference && <p className="pl-2">Ref: {slip.refundReference}</p>}
        </div>
        <p className="border-t border-dashed border-black pt-1">Reason: {slip.reason}</p>
      </div>

      <div className="flex min-w-56 flex-col gap-3 print:hidden">
        <Button type="button" size="lg" onClick={() => window.print()} data-testid="print-return-slip">
          <Printer className="size-4" aria-hidden /> Print the slip
        </Button>
        {slip.canOpenSale && (
          <Link href={`/sales/${slip.sale.id}`} className={buttonVariants({ variant: "outline", size: "lg" })}>
            Open sale {slip.sale.receiptNumber}
          </Link>
        )}
        <dl className="max-w-64 text-sm">
          <dt className="text-xs text-muted-foreground">Approved by</dt>
          <dd>{slip.approvedByName}</dd>
          <dt className="mt-2 text-xs text-muted-foreground">Where the goods went</dt>
          {slip.lines.map((line) => (
            <dd key={line.lineNumber}>
              {plainNumber(line.quantity)} {line.unitName} {line.productName}: {PLACES[line.disposition]}
            </dd>
          ))}
          {slip.writtenOffCost !== null && slip.writtenOffCost !== "0.00" && (
            <>
              <dt className="mt-2 text-xs text-muted-foreground">Cost of what was written off</dt>
              <dd data-testid="return-written-off">{nairaFromText(slip.writtenOffCost)}</dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}
