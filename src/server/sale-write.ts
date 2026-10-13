import "server-only";
import { Decimal } from "@/lib/decimal";
import { plainNumber } from "@/lib/format";
import { moneyToString, roundMoney, shareDiscount, sumMoney, taxIncludedIn } from "@/lib/money";
import type { PaymentKindValue } from "@/lib/payment-kinds";
import { quantityToString } from "@/lib/quantity";
import type { AppContext } from "@/server/auth/context";
import { type businessDb, businessIdOf } from "@/server/db/scoped";
import { ValidationError } from "@/server/errors";
import type { OfflineNote } from "@/server/offline-cashier";
import type { CheckedSaleLine } from "@/server/sale-lines";
import { refreshBatches } from "@/server/stock-batches";
import { addStockOwed } from "@/server/stock-owed";

type Tx = Parameters<Parameters<ReturnType<typeof businessDb>["$transaction"]>[0]>[0];

export type CheckedPayment = {
  method: { id: string; name: string; kind: PaymentKindValue };
  amount: Decimal;
  tendered: Decimal | null;
  change: Decimal | null;
  reference: string | null;
};

export type SaleToWrite = {
  requestId: string;
  terminal: { id: string; code: string };
  sequence: number;
  receiptNumber: string;
  lines: CheckedSaleLine[];
  locationName: Map<string, string>;
  /** The discount on the whole sale (zero for none), and the sale's total after it. */
  discount: Decimal;
  discountPercent: Decimal | null;
  discountReason: string | null;
  total: Decimal;
  customer: { id: string; name: string; phone: string } | null;
  /**
   * The part of the total put on the customer's account. The caller has already raised the
   * customer's balance (the customer's "turn" comes before any product's) and passes what
   * they owe after it.
   */
  credit: Decimal;
  owedAfter: Decimal | null;
  creditNote: string | null;
  payments: CheckedPayment[];
  /** The open till the sale belongs to. Only a sale brought in from Excel has none. */
  tillSessionId: string | null;
  cashier: { userId: string | null; name: string };
  deviceTime: Date | null;
  offline: boolean;
  sentBy: { userId: string; name: string } | null;
  /**
   * For a sale whose goods have already left the shop (made without internet, or brought in
   * from the shop's records): if the system holds less than was sold, what it holds is taken
   * and the rest is noted, instead of refusing the sale.
   */
  acceptShortage: boolean;
  /** What a manager should look at; shortages found here are added. All are saved as exceptions. */
  notes: OfflineNote[];
  /** For a sale brought in from Excel: the import, and the moment it was really made. */
  imported?: { runId: string; at: Date };
  /** For an import that replays many sales: the caller works the batches out once, at the end. */
  deferBatches?: boolean;
  /** The tax rate, when the caller has read it already. Otherwise it is read here. */
  taxRate?: Decimal;
};

/**
 * Writes one sale — the stock leaving its place, the sale, the customer's account line, the
 * lines, the movements, any exceptions, and the payments last — inside the transaction it is
 * given. The ONE place a sale is written: the checkout, sales made without internet and
 * sales brought in from Excel all come through here.
 *
 * Not an operation: the caller has checked who is asking and that every line, the discount
 * and the payments are sound; has taken the terminal's turn (and the customer's, if there is
 * credit); and runs this in a ReadCommitted transaction. Products are taken here, in sorted
 * order, before any row that refers to one is written.
 */
export async function writeSale(tx: Tx, context: AppContext, sale: SaleToWrite): Promise<{ id: string }> {
  const businessId = businessIdOf(context);
  const { lines: checked, receiptNumber, notes } = sale;
  const at = sale.imported ? { createdAt: sale.imported.at } : {};

  // What each product loses from each location, in base units.
  const perPlace = new Map<string, Map<string, Decimal>>();
  for (const line of checked) {
    const places = perPlace.get(line.productId) ?? new Map<string, Decimal>();
    places.set(line.location.id, (places.get(line.location.id) ?? new Decimal(0)).plus(line.baseQuantity));
    perPlace.set(line.productId, places);
  }
  // Always in the same order (product, then location), so two sales cannot block each other.
  const productOrder = [...perPlace.keys()].sort();

  // The tax rate at this moment; it is copied onto the sale and never looked up again.
  let rate = sale.taxRate;
  if (!rate) {
    const business = await tx.business.findFirst({ select: { taxRatePercent: true } });
    rate = new Decimal(business?.taxRatePercent.toFixed(2) ?? "0");
  }

  const short: Record<string, string> = {};
  // What each line could not take out of stock, in base units (only when a shortage is accepted).
  const shortOf = new Map<number, Decimal>();
  const costOf = new Map<string, Decimal>();
  for (const productId of productOrder) {
    // The product's "turn", as for every other stock change; its average cost is read here.
    const product = await tx.product.update({
      where: { id: productId },
      data: { updatedAt: new Date() },
      select: { averageCost: true },
    });
    costOf.set(productId, new Decimal(product.averageCost.toFixed(4)));

    const places = [...perPlace.get(productId)!.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [locationId, quantity] of places) {
      // Taken out only if that much is there — one statement, so two cashiers can never
      // both sell the last one.
      const needed = quantityToString(quantity);
      const lowered = await tx.stockBalance.updateMany({
        where: { productId, locationId, quantity: { gte: needed } },
        data: { quantity: { decrement: needed } },
      });
      if (lowered.count === 1) continue;
      const there = await tx.stockBalance.findFirst({ where: { productId, locationId }, select: { quantity: true } });
      if (sale.acceptShortage) {
        // The goods have left the shop. Take what the system holds (this product's turn is
        // ours, so nobody else can change it meanwhile) and note the rest, line by line.
        const held = new Decimal(there?.quantity.toFixed(3) ?? "0");
        if (held.greaterThan(0)) {
          const taken = await tx.stockBalance.updateMany({
            where: { productId, locationId, quantity: { gte: quantityToString(held) } },
            data: { quantity: { decrement: quantityToString(held) } },
          });
          if (taken.count !== 1) throw new Error("Stock changed while it was being taken for a sale that had already happened.");
        }
        let left = held;
        for (const line of checked) {
          if (line.productId !== productId || line.location.id !== locationId) continue;
          const moved = Decimal.min(left, line.baseQuantity);
          left = left.minus(moved);
          if (moved.lessThan(line.baseQuantity)) shortOf.set(line.index, line.baseQuantity.minus(moved));
        }
        // The place now owes what could not be taken; it is covered as stock next arrives there (C72).
        await addStockOwed(tx, context, { productId, locationId, quantity: quantity.minus(held) });
        const first = checked.find((line) => line.productId === productId && line.location.id === locationId)!;
        notes.push({
          kind: "STOCK_SHORT",
          summary:
            `${plainNumber(needed)} ${first.baseUnitName} of "${first.productName}" was sold, but the system held only ` +
            `${plainNumber(quantityToString(held))} in ${sale.locationName.get(locationId)}. Settle it with a transfer, a delivery or an adjustment (Stock, then Sold beyond stock).`,
        });
        continue;
      }
      for (const line of checked) {
        if (line.productId !== productId || line.location.id !== locationId) continue;
        short[`lines.${line.index}.quantity`] =
          `Only ${plainNumber(there?.quantity.toFixed(3) ?? "0")} ${line.baseUnitName} of "${line.productName}" is in ` +
          `${sale.locationName.get(locationId)}. This sale needs ${plainNumber(needed)} ${line.baseUnitName}.`;
      }
    }
  }
  // Throwing here undoes everything above, including the products that had enough.
  if (Object.keys(short).length > 0) {
    throw new ValidationError("Nothing was sold: there is not enough stock.", short);
  }

  // What is left of each batch of these products is worked out again (C73).
  if (!sale.deferBatches) await refreshBatches(tx, context, productOrder);

  // The discount is shared out over the lines, so each line knows what was really charged for it.
  const shares = shareDiscount(
    checked.map((line) => line.lineTotal),
    sale.discount,
  );
  const lines = checked.map((line, position) => {
    const lineRate = line.taxable ? rate : new Decimal(0);
    const baseUnitCost = costOf.get(line.productId)!;
    return {
      line,
      lineNumber: position + 1,
      discountAmount: shares[position],
      taxRatePercent: lineRate,
      // Tax is what is inside the amount actually charged.
      taxAmount: taxIncludedIn(line.lineTotal.minus(shares[position]), lineRate),
      baseUnitCost,
      lineCost: roundMoney(line.baseQuantity.times(baseUnitCost)),
    };
  });

  const saved = await tx.sale.create({
    data: {
      businessId,
      requestId: sale.requestId,
      terminalId: sale.terminal.id,
      terminalCode: sale.terminal.code,
      sequence: sale.sequence,
      receiptNumber,
      total: moneyToString(sale.total),
      discountAmount: moneyToString(sale.discount),
      discountPercent: sale.discountPercent ? sale.discountPercent.toFixed(2) : null,
      discountReason: sale.discount.greaterThan(0) ? sale.discountReason : null,
      taxRatePercent: rate.toFixed(2),
      taxTotal: moneyToString(sumMoney(lines.map((entry) => entry.taxAmount))),
      costTotal: moneyToString(sumMoney(lines.map((entry) => entry.lineCost))),
      cashierUserId: sale.cashier.userId,
      cashierName: sale.cashier.name,
      deviceTime: sale.deviceTime,
      offline: sale.offline,
      sentByUserId: sale.sentBy?.userId ?? null,
      sentByName: sale.sentBy?.name ?? null,
      tillSessionId: sale.tillSessionId,
      importRunId: sale.imported?.runId ?? null,
      customerId: sale.customer?.id ?? null,
      customerName: sale.customer?.name ?? null,
      customerPhone: sale.customer?.phone ?? null,
      creditAmount: moneyToString(sale.credit),
      ...at,
    },
    select: { id: true },
  });
  if (sale.customer && sale.owedAfter) {
    await tx.customerAccountEntry.create({
      data: {
        businessId,
        customerId: sale.customer.id,
        type: "CREDIT_SALE",
        amount: moneyToString(sale.credit),
        balanceAfter: moneyToString(sale.owedAfter),
        saleId: saved.id,
        documentNumber: receiptNumber,
        note: sale.creditNote,
        createdByUserId: context.actor.userId,
        createdByName: context.actor.name,
        ...at,
      },
    });
  }
  await tx.saleLine.createMany({
    data: lines.map(({ line, ...extra }) => ({
      businessId,
      saleId: saved.id,
      lineNumber: extra.lineNumber,
      productId: line.productId,
      productUnitId: line.productUnitId,
      productName: line.productName,
      unitName: line.unitName,
      unitFactor: line.unitFactor,
      quantity: line.quantity,
      baseQuantity: quantityToString(line.baseQuantity),
      stockShort: quantityToString(shortOf.get(line.index) ?? new Decimal(0)),
      unitPrice: moneyToString(line.unitPrice),
      lineTotal: moneyToString(line.lineTotal),
      discountAmount: moneyToString(extra.discountAmount),
      taxable: line.taxable,
      taxRatePercent: extra.taxRatePercent.toFixed(2),
      taxAmount: moneyToString(extra.taxAmount),
      baseUnitCost: extra.baseUnitCost.toFixed(4),
      lineCost: moneyToString(extra.lineCost),
      locationId: line.location.id,
      locationName: line.location.name,
    })),
  });
  const movements = checked.flatMap((line) => {
    // A line that was partly (or wholly) not in stock moves only what was there, written in
    // the base unit.
    const lacking = shortOf.get(line.index);
    const moved = lacking ? line.baseQuantity.minus(lacking) : line.baseQuantity;
    if (!moved.greaterThan(0)) return [];
    return [
      {
        businessId,
        productId: line.productId,
        locationId: line.location.id,
        type: "SALE" as const,
        quantityDelta: `-${quantityToString(moved)}`,
        unitName: lacking ? line.baseUnitName : line.unitName,
        unitFactor: lacking ? "1.000" : line.unitFactor,
        unitQuantity: lacking ? `-${quantityToString(moved)}` : `-${line.quantity}`,
        documentType: "sale",
        documentId: saved.id,
        documentNumber: receiptNumber,
        userId: context.actor.userId,
        userName: context.actor.name,
        ...at,
      },
    ];
  });
  if (movements.length > 0) await tx.stockMovement.createMany({ data: movements });
  if (notes.length > 0) {
    await tx.offlineException.createMany({
      data: notes.map((note) => ({ businessId, saleId: saved.id, kind: note.kind, summary: note.summary.slice(0, 500) })),
    });
  }

  // The payments are written last: if they cannot be saved, nothing of the sale is.
  if (sale.payments.length > 0) {
    await tx.payment.createMany({
      data: sale.payments.map((payment) => ({
        businessId,
        saleId: saved.id,
        methodId: payment.method.id,
        methodName: payment.method.name,
        kind: payment.method.kind,
        amount: moneyToString(payment.amount),
        tendered: payment.tendered ? moneyToString(payment.tendered) : null,
        changeGiven: payment.change ? moneyToString(payment.change) : null,
        reference: payment.reference,
        tillSessionId: sale.tillSessionId,
        receivedByUserId: context.actor.userId,
        receivedByName: context.actor.name,
        ...at,
      })),
    });
  }
  return { id: saved.id };
}
