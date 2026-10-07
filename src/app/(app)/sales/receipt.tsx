import { formatDateTime, nairaFromText, plainNumber } from "@/lib/format";
import type { SaleDetail } from "@/server/business/sales";

/**
 * A sales receipt as it is printed (SPEC C44), sized for the terminal's paper: 58 mm or 80 mm.
 * Shown on screen as a preview; when printing, only this is sent to the printer (see globals.css).
 * Plain black on white and no fixed heights, so nothing is cut off whatever the length.
 */
export function Receipt({ sale, reprint }: { sale: SaleDetail; reprint: boolean }) {
  const lines = (text: string | null) =>
    (text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const hasTax = sale.taxTotal !== "0.00";

  return (
    <div
      className="receipt-paper flex flex-col gap-1.5 rounded-md border bg-white p-2 leading-snug break-words text-black shadow-sm"
      data-width={sale.paperWidth}
      data-testid="receipt"
    >
      <div className="text-center">
        <p className="text-[1.25em] font-bold">{sale.business.name}</p>
        {lines(sale.business.receiptHeader).map((line, index) => (
          <p key={index}>{line}</p>
        ))}
        {sale.business.taxNumber && <p>TIN: {sale.business.taxNumber}</p>}
      </div>

      {reprint && (
        <p className="border-y border-dashed border-black py-0.5 text-center font-bold tracking-widest" data-testid="reprint-mark">
          *** REPRINT ***
        </p>
      )}

      <div className="border-t border-dashed border-black pt-1">
        <p>Receipt: {sale.receiptNumber}</p>
        <p>Date: {formatDateTime(sale.createdAt)}</p>
        <p>Served by: {sale.cashierName}</p>
      </div>

      <div className="flex flex-col gap-1 border-t border-dashed border-black pt-1">
        {sale.lines.map((line) => (
          <div key={line.lineNumber} data-testid={`receipt-item-${line.lineNumber}`}>
            <p className="font-semibold">{line.productName}</p>
            {/* On narrow paper the line total drops to its own row, still at the right edge. */}
            <p className="flex flex-wrap justify-between gap-x-2 tabular-nums">
              <span className="whitespace-nowrap">
                {plainNumber(line.quantity)} {line.unitName} × {nairaFromText(line.unitPrice)}
              </span>
              <span className="ml-auto">{nairaFromText(line.lineTotal)}</span>
            </p>
          </div>
        ))}
      </div>

      <div className="border-t border-dashed border-black pt-1 tabular-nums">
        <p className="flex justify-between gap-2 text-[1.25em] font-bold">
          <span>TOTAL</span>
          <span data-testid="receipt-total-amount">{nairaFromText(sale.total)}</span>
        </p>
        {hasTax && (
          <p className="flex justify-between gap-2">
            <span>Includes tax ({plainNumber(sale.taxRatePercent)}%)</span>
            <span data-testid="receipt-tax">{nairaFromText(sale.taxTotal)}</span>
          </p>
        )}
        <p className="flex justify-between gap-2">
          <span>Cash</span>
          <span>{nairaFromText(sale.tendered)}</span>
        </p>
        <p className="flex justify-between gap-2">
          <span>Change</span>
          <span data-testid="receipt-change">{nairaFromText(sale.change)}</span>
        </p>
      </div>

      {lines(sale.business.receiptFooter).length > 0 && (
        <div className="border-t border-dashed border-black pt-1 text-center">
          {lines(sale.business.receiptFooter).map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}
