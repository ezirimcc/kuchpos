import "server-only";
import { Decimal } from "@/lib/decimal";
import { dayToDate, formatDay, receiptNumber } from "@/lib/format";
import { formatNaira, moneyToString, movingAverageCost, sumMoney } from "@/lib/money";
import { quantityToString } from "@/lib/quantity";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { type businessDb, businessIdOf } from "@/server/db/scoped";
import { takeDocumentNumber } from "@/server/document-number";
import { refreshBatches } from "@/server/stock-batches";
import { coverStockOwed } from "@/server/stock-owed";
import type { CheckedLine } from "@/server/receipt-lines";

type Tx = Parameters<Parameters<ReturnType<typeof businessDb>["$transaction"]>[0]>[0];

/**
 * Writes one delivery — the record, its lines, version 1, the stock coming in, the new
 * average cost, the movements and the activity-log line — inside the transaction it is
 * given. The ONE place a delivery is written: receiving goods on the screen and bringing
 * stock and deliveries in from Excel both come through here.
 *
 * Not an operation: the caller has checked who is asking and that every line is sound, and
 * runs this in a ReadCommitted transaction (see the stock rules in CLAUDE.md).
 */
export async function writeGoodsReceipt(
  tx: Tx,
  context: AppContext,
  delivery: {
    requestId: string;
    supplier: { id: string; name: string };
    location: { id: string; name: string };
    /** The delivery date as "YYYY-MM-DD". */
    receivedOn: string;
    backdated: boolean;
    backdateNote: string | null;
    invoiceNumber: string | null;
    note: string | null;
    lines: CheckedLine[];
    /**
     * For stock brought in by an import: the kind of movement (opening stock is not a
     * delivery from a supplier) and the moment the movements are dated — the day the stock
     * was counted or the goods arrived, so that reports of that time are right.
     */
    imported?: { movementType: "RECEIPT" | "OPENING_BALANCE"; at: Date; label: string };
    /** For an import that replays many documents: the caller works the batches out once, at the end. */
    deferBatches?: boolean;
  },
): Promise<{ id: string; number: number }> {
  const businessId = businessIdOf(context);
  const { supplier, location, lines: checked } = delivery;
  const receivedDate = dayToDate(delivery.receivedOn)!;
  const totalCost = sumMoney(checked.map((line) => line.lineCost));

  // What each product gains in this delivery, in base units and in cost.
  const perProduct = new Map<string, { quantity: Decimal; cost: Decimal }>();
  for (const line of checked) {
    const sum = perProduct.get(line.productId) ?? { quantity: new Decimal(0), cost: new Decimal(0) };
    perProduct.set(line.productId, { quantity: sum.quantity.plus(line.baseQuantity), cost: sum.cost.plus(line.lineCost) });
  }
  // Always in the same order, so two deliveries saved at the same moment cannot block each other.
  const productOrder = [...perProduct.keys()].sort();

  const number = await takeDocumentNumber(tx, businessId, "GOODS_RECEIPT");
  // Each product's "turn" is taken before anything that refers to the product is written.
  // (Writing a line first would hold a weaker lock on the product, and asking for the
  // stronger one afterwards can deadlock with a sale of the same product.)
  for (const productId of productOrder) {
    await tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() }, select: { id: true } });
  }

  const receipt = await tx.goodsReceipt.create({
    data: {
      businessId,
      requestId: delivery.requestId,
      number,
      supplierId: supplier.id,
      supplierName: supplier.name,
      locationId: location.id,
      locationName: location.name,
      receivedOn: receivedDate,
      backdated: delivery.backdated,
      backdateNote: delivery.backdateNote,
      invoiceNumber: delivery.invoiceNumber,
      note: delivery.note,
      totalCost: moneyToString(totalCost),
      createdByUserId: context.actor.userId,
      createdByName: context.actor.name,
    },
  });

  const lineRows = checked.map((line, index) => ({
    businessId,
    lineNumber: index + 1,
    productId: line.productId,
    productUnitId: line.productUnitId,
    productName: line.productName,
    unitName: line.unitName,
    unitFactor: line.unitFactor,
    quantity: line.quantity,
    baseQuantity: quantityToString(line.baseQuantity),
    unitCost: line.unitCost,
    lineCost: moneyToString(line.lineCost),
    batchNumber: line.batchNumber,
    expiryDate: line.expiryDate,
  }));
  await tx.goodsReceiptLine.createMany({ data: lineRows.map((line) => ({ ...line, receiptId: receipt.id })) });

  // The delivery exactly as first saved is kept as version 1, which can never be changed.
  const original = await tx.goodsReceiptVersion.create({
    data: {
      businessId,
      receiptId: receipt.id,
      version: 1,
      supplierId: supplier.id,
      supplierName: supplier.name,
      locationId: location.id,
      locationName: location.name,
      receivedOn: receivedDate,
      invoiceNumber: delivery.invoiceNumber,
      note: delivery.note,
      totalCost: moneyToString(totalCost),
      createdByUserId: context.actor.userId,
      createdByName: context.actor.name,
      createdAt: receipt.createdAt,
    },
    select: { id: true },
  });
  await tx.goodsReceiptVersionLine.createMany({ data: lineRows.map((line) => ({ ...line, versionId: original.id })) });

  for (const productId of productOrder) {
    const added = perProduct.get(productId)!;
    // Touching the product row makes any other delivery of the same product wait its turn,
    // so the stock total read on the next line is the true total.
    const product = await tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() }, select: { averageCost: true } });
    const before = await tx.stockBalance.aggregate({ where: { productId }, _sum: { quantity: true } });
    const average = movingAverageCost({
      quantityBefore: new Decimal(before._sum.quantity?.toFixed(3) ?? "0"),
      averageBefore: new Decimal(product.averageCost.toFixed(4)),
      quantityAdded: added.quantity,
      costAdded: added.cost,
    });
    await tx.product.update({ where: { id: productId }, data: { averageCost: average.toFixed(4) } });

    const increased = await tx.stockBalance.updateMany({
      where: { productId, locationId: location.id },
      data: { quantity: { increment: quantityToString(added.quantity) } },
    });
    if (increased.count === 0) {
      await tx.stockBalance.create({ data: { businessId, productId, locationId: location.id, quantity: quantityToString(added.quantity) } });
    }
    // If this place owes any of the product to a sale beyond stock, the delivery covers it first (C72).
    await coverStockOwed(tx, context, { productId, locationId: location.id, arrivedWith: receiptNumber(number), at: delivery.imported?.at });
  }

  // What is left of each batch of these products is worked out again (C73).
  if (!delivery.deferBatches) await refreshBatches(tx, context, productOrder);

  await tx.stockMovement.createMany({
    data: checked.map((line) => ({
      businessId,
      productId: line.productId,
      locationId: location.id,
      type: delivery.imported?.movementType ?? ("RECEIPT" as const),
      quantityDelta: quantityToString(line.baseQuantity),
      unitName: line.unitName,
      unitFactor: line.unitFactor,
      unitQuantity: line.quantity,
      documentType: "goods_receipt",
      documentId: receipt.id,
      documentNumber: receiptNumber(number),
      userId: context.actor.userId,
      userName: context.actor.name,
      ...(delivery.imported ? { createdAt: delivery.imported.at } : {}),
    })),
  });

  const lineCount = `${checked.length} line${checked.length === 1 ? "" : "s"}`;
  await tx.activityLog.create({
    data: activityRow(context, {
      action: delivery.imported ? "stock.imported" : delivery.backdated ? "stock.received_backdated" : "stock.received",
      summary: delivery.imported
        ? `${context.actor.name} brought in ${delivery.imported.label} as ${receiptNumber(number)}, dated ${formatDay(delivery.receivedOn)}, into ${location.name}: ${lineCount}, ${formatNaira(totalCost)}.`
        : `${context.actor.name} recorded delivery ${receiptNumber(number)} from ${supplier.name} into ${location.name}: ` +
          `${lineCount}, ${formatNaira(totalCost)}.` +
          (delivery.backdated ? ` BACKDATED to ${formatDay(delivery.receivedOn)} — reason: ${delivery.backdateNote}` : ""),
      targetType: "goods_receipt",
      targetId: receipt.id,
      details: { number, receivedOn: delivery.receivedOn, backdated: delivery.backdated, lines: checked.length, totalCost: moneyToString(totalCost) },
    }),
  });

  return { id: receipt.id, number };
}
