import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import { dayToDate, plainNumber, shopToday } from "@/lib/format";
import { formatNaira, moneyToString, roundMoney, sumMoney } from "@/lib/money";
import { parseQuantity, quantityToString, toBaseQuantity } from "@/lib/quantity";
import type { businessDb } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";

/**
 * Working out a return of goods against a sale (C62): which lines, how much of each may
 * still come back, what was actually paid for it, and where it goes. Shared by `postReturn`
 * (saving it) and by approvals (a manager approves exactly this), so both see the return the
 * same way. Not an operation: callers have checked who is asking and pass their
 * business-scoped client, or the transaction they are in.
 */

type Db = ReturnType<typeof businessDb>;
type Reader = Pick<Db, "sale" | "saleReturnLine" | "location" | "business" | "product">;

export const DISPOSITIONS = ["SHELF", "STOREROOM", "WRITTEN_OFF"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const returnSchema = z.object({
  /** The return's unique ID, made up on the person's computer. */
  requestId: z.string().uuid("This form has expired. Reload the page."),
  saleId: z.string().uuid("That sale could not be found."),
  reason: z.string().trim().min(3, "Say why the goods are coming back.").max(300, "The reason is too long (300 characters at most)."),
  lines: z
    .array(
      z.object({
        saleLineId: z.string().uuid(),
        quantity: z.string().trim(),
        disposition: z.enum(DISPOSITIONS, "Say where the goods go."),
      }),
    )
    .min(1, "Enter how many of at least one item came back.")
    .max(200),
  /** How whatever is not taken off the customer's debt is handed back. Empty when nothing is. */
  refundMethodId: z.string().trim().optional().default(""),
  refundReference: z.string().trim().max(60, "The reference is too long (60 characters at most).").optional().default(""),
  /** For a cash refund: the checkout whose till the cash comes out of. */
  terminalId: z.string().trim().optional().default(""),
});
export type ReturnInput = z.infer<typeof returnSchema>;

export type ReturnableLine = {
  saleLineId: string;
  lineNumber: number;
  productId: string;
  productName: string;
  unitName: string;
  unitFactor: string;
  allowsFraction: boolean;
  /** Sold, already returned, and what may still come back — in the unit it was sold in. */
  sold: string;
  returned: string;
  returnable: string;
  /** What was actually paid for the whole line (after any discount), and what has been refunded of it. */
  paid: string;
  refunded: string;
};

export type WorkedOutLine = {
  saleLineId: string;
  lineNumber: number;
  productId: string;
  productName: string;
  unitName: string;
  unitFactor: string;
  quantity: Decimal;
  baseQuantity: Decimal;
  refundAmount: Decimal;
  taxAmount: Decimal;
  lineCost: Decimal;
  disposition: Disposition;
  location: { id: string; name: string } | null;
};

export type WorkedOutReturn = {
  sale: {
    id: string;
    receiptNumber: string;
    terminalId: string;
    terminalCode: string;
    customerId: string | null;
    customerName: string | null;
    creditAmount: Decimal;
    createdAt: Date;
  };
  lines: WorkedOutLine[];
  refundTotal: Decimal;
  fingerprint: string;
};

/** The sale and what may still come back from each of its lines. Throws "not found" for another business's sale. */
export async function returnableLines(
  db: Reader,
  saleId: string,
): Promise<{
  sale: WorkedOutReturn["sale"] & { cancelled: boolean; cashierName: string };
  lines: (ReturnableLine & { net: Decimal; taxAmount: Decimal; lineCost: Decimal; soldQuantity: Decimal; returnedQuantity: Decimal; refundedSoFar: Decimal })[];
  /** The last shop day on which goods of this sale may be returned; null when there is no limit. */
  lastDay: string | null;
}> {
  const sale = await db.sale.findFirst({
    where: { id: saleId },
    select: {
      id: true,
      receiptNumber: true,
      terminalId: true,
      terminalCode: true,
      customerId: true,
      customerName: true,
      creditAmount: true,
      createdAt: true,
      cashierName: true,
      cancellation: { select: { id: true } },
      lines: { orderBy: { lineNumber: "asc" } },
    },
  });
  if (!sale) throw new NotFoundError("That sale could not be found.");
  const [back, products, business] = await Promise.all([
    db.saleReturnLine.groupBy({
      by: ["saleLineId"],
      where: { saleLineId: { in: sale.lines.map((line) => line.id) } },
      _sum: { quantity: true, refundAmount: true },
    }),
    db.product.findMany({ where: { id: { in: sale.lines.map((line) => line.productId) } }, select: { id: true, allowsFraction: true } }),
    db.business.findFirst({ select: { returnDays: true } }),
  ]);
  const backOf = new Map(back.map((group) => [group.saleLineId, group._sum]));
  const fractions = new Map(products.map((product) => [product.id, product.allowsFraction]));
  const days = business?.returnDays ?? 0;
  let lastDay: string | null = null;
  if (days > 0) {
    const soldOn = dayToDate(shopToday(sale.createdAt))!;
    lastDay = new Date(soldOn.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  return {
    lastDay,
    sale: {
      id: sale.id,
      receiptNumber: sale.receiptNumber,
      terminalId: sale.terminalId,
      terminalCode: sale.terminalCode,
      customerId: sale.customerId,
      customerName: sale.customerName,
      creditAmount: new Decimal(sale.creditAmount.toFixed(2)),
      createdAt: sale.createdAt,
      cashierName: sale.cashierName,
      cancelled: !!sale.cancellation,
    },
    lines: sale.lines.map((line) => {
      const soldQuantity = new Decimal(line.quantity.toFixed(3));
      const returnedQuantity = new Decimal(backOf.get(line.id)?.quantity?.toFixed(3) ?? "0");
      const refundedSoFar = new Decimal(backOf.get(line.id)?.refundAmount?.toFixed(2) ?? "0");
      const net = new Decimal(line.lineTotal.toFixed(2)).minus(line.discountAmount.toFixed(2));
      return {
        saleLineId: line.id,
        lineNumber: line.lineNumber,
        productId: line.productId,
        productName: line.productName,
        unitName: line.unitName,
        unitFactor: line.unitFactor.toFixed(3),
        allowsFraction: fractions.get(line.productId) ?? false,
        sold: quantityToString(soldQuantity),
        returned: quantityToString(returnedQuantity),
        returnable: quantityToString(soldQuantity.minus(returnedQuantity)),
        paid: moneyToString(net),
        refunded: moneyToString(refundedSoFar),
        net,
        taxAmount: new Decimal(line.taxAmount.toFixed(2)),
        lineCost: new Decimal(line.lineCost.toFixed(2)),
        soldQuantity,
        returnedQuantity,
        refundedSoFar,
      };
    }),
  };
}

/**
 * Checks a return against the sale as it stands and works out every amount. Problems with a
 * line are keyed `lines.N.quantity` / `lines.N.disposition`; anything that stops the whole
 * return is thrown as its headline.
 */
export async function workOutReturn(db: Reader, data: ReturnInput, headline: string): Promise<WorkedOutReturn> {
  const { sale, lines: saleLines, lastDay } = await returnableLines(db, data.saleId);
  if (sale.cancelled) throw new ValidationError(`${headline} Sale ${sale.receiptNumber} was cancelled, so nothing of it can be returned.`);
  if (lastDay && shopToday() > lastDay) {
    throw new ValidationError(
      `${headline} Sale ${sale.receiptNumber} is too old: its goods could be returned until ${lastDay.split("-").reverse().join("/")}. An admin can change the number of days allowed in Settings.`,
    );
  }
  const locations = await db.location.findMany({ select: { id: true, name: true, kind: true } });
  const placeOf = (disposition: Disposition) =>
    disposition === "WRITTEN_OFF" ? null : (locations.find((location) => location.kind === disposition) ?? null);

  const fieldErrors: Record<string, string> = {};
  const seen = new Set<string>();
  const lines: WorkedOutLine[] = [];
  data.lines.forEach((entry, index) => {
    const at = (field: string) => `lines.${index}.${field}`;
    const line = saleLines.find((candidate) => candidate.saleLineId === entry.saleLineId);
    if (!line || seen.has(entry.saleLineId)) {
      fieldErrors[at("quantity")] = "This item is not on that sale. Reload the page.";
      return;
    }
    seen.add(entry.saleLineId);
    let quantity: Decimal;
    try {
      quantity = parseQuantity(entry.quantity);
      if (!quantity.greaterThan(0)) throw new Error("not positive");
    } catch {
      fieldErrors[at("quantity")] = "Enter how many came back, as a number greater than zero.";
      return;
    }
    if (!line.allowsFraction && !quantity.isInteger()) {
      fieldErrors[at("quantity")] = `"${line.productName}" is sold in whole units only. Enter a whole number.`;
      return;
    }
    const remaining = line.soldQuantity.minus(line.returnedQuantity);
    if (quantity.greaterThan(remaining)) {
      fieldErrors[at("quantity")] = remaining.greaterThan(0)
        ? `Only ${plainNumber(quantityToString(remaining))} ${line.unitName} of "${line.productName}" can still come back from this sale.`
        : `All of "${line.productName}" on this sale has already been returned.`;
      return;
    }
    const location = placeOf(entry.disposition);
    if (entry.disposition !== "WRITTEN_OFF" && !location) {
      fieldErrors[at("disposition")] = "This business has no such place to put the goods back.";
      return;
    }
    // What was actually paid for these: their share of the line. The last ones to come back
    // take whatever is left, so the refunds of a line can never add up to more than it fetched.
    const share = quantity.dividedBy(line.soldQuantity);
    const everythingLeft = quantity.equals(remaining);
    const refundAmount = everythingLeft ? line.net.minus(line.refundedSoFar) : Decimal.min(roundMoney(line.net.times(share)), line.net.minus(line.refundedSoFar));
    lines.push({
      saleLineId: line.saleLineId,
      lineNumber: index + 1,
      productId: line.productId,
      productName: line.productName,
      unitName: line.unitName,
      unitFactor: line.unitFactor,
      quantity,
      baseQuantity: toBaseQuantity(quantity, new Decimal(line.unitFactor)),
      refundAmount: Decimal.max(refundAmount, 0),
      taxAmount: Decimal.min(roundMoney(line.taxAmount.times(share)), Decimal.max(refundAmount, 0)),
      lineCost: roundMoney(line.lineCost.times(share)),
      disposition: entry.disposition,
      location: location ? { id: location.id, name: location.name } : null,
    });
  });
  if (Object.keys(fieldErrors).length > 0) throw new ValidationError(headline, fieldErrors);

  const refundTotal = sumMoney(lines.map((line) => line.refundAmount));
  return {
    sale,
    lines,
    refundTotal,
    fingerprint: createHash("sha256")
      .update(
        [
          "return",
          data.requestId,
          sale.id,
          data.refundMethodId,
          ...lines.map((line) => [line.saleLineId, quantityToString(line.quantity), line.disposition, moneyToString(line.refundAmount)].join("|")),
        ].join("\n"),
      )
      .digest("hex"),
  };
}

/** A return in a few words, for approvers and the activity log. */
export function describeReturn(worked: WorkedOutReturn): string {
  return `a return of ${formatNaira(worked.refundTotal)} against sale ${worked.sale.receiptNumber}`;
}
