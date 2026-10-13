import "server-only";
import { Decimal } from "@/lib/decimal";
import { quantityToString } from "@/lib/quantity";
import type { AppContext } from "@/server/auth/context";
import { type businessDb, businessIdOf } from "@/server/db/scoped";

/**
 * Stock "owed" (C72). When a sale whose goods have already left the shop — one made without
 * internet, or brought in from the shop's records — takes more than the system holds in a
 * place, the balance there goes to zero (never below: the database refuses that) and the
 * rest is recorded as owed by that place. As stock next arrives there, what is owed is taken
 * out of it at once, with a movement of its own. On screen it reads like negative stock;
 * in the database every balance is still zero or more and still equals the sum of its movements.
 *
 * The rule tests hold to: owed = the shortfalls of that product's sale lines in that place,
 * less the SHORTFALL_COVERED movements there.
 *
 * Not operations. Both functions must be called inside a stock transaction with the
 * product's "turn" already taken, like every other change of stock.
 */

type Db = ReturnType<typeof businessDb>;
type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

/** Records that a place owes this much more of a product (a sale took more than it held). */
export async function addStockOwed(tx: Tx, context: AppContext, input: { productId: string; locationId: string; quantity: Decimal }): Promise<void> {
  if (!input.quantity.greaterThan(0)) return;
  const more = quantityToString(input.quantity);
  const raised = await tx.stockOwed.updateMany({ where: { productId: input.productId, locationId: input.locationId }, data: { quantity: { increment: more } } });
  if (raised.count === 0) {
    await tx.stockOwed.create({ data: { businessId: businessIdOf(context), productId: input.productId, locationId: input.locationId, quantity: more } });
  }
}

/**
 * Call straight after stock has been ADDED to a place. If that place owes any of the
 * product, as much of it as the place now holds is taken out again and noted as a
 * SHORTFALL_COVERED movement. Returns what was taken (zero when nothing was owed).
 */
export async function coverStockOwed(
  tx: Tx,
  context: AppContext,
  input: {
    productId: string;
    locationId: string;
    /** The number of the document that brought the stock in ("TR-000004"), for the movement's line. */
    arrivedWith: string;
    /** For stock brought in with a date in the past (an import): the moment to give the movement. */
    at?: Date;
  },
): Promise<Decimal> {
  const none = new Decimal(0);
  const owed = await tx.stockOwed.findFirst({ where: { productId: input.productId, locationId: input.locationId, quantity: { gt: 0 } }, select: { id: true, quantity: true } });
  if (!owed) return none;
  const balance = await tx.stockBalance.findFirst({ where: { productId: input.productId, locationId: input.locationId }, select: { quantity: true } });
  const taking = Decimal.min(new Decimal(owed.quantity.toFixed(3)), new Decimal(balance?.quantity.toFixed(3) ?? "0"));
  if (!taking.greaterThan(0)) return none;

  const amount = quantityToString(taking);
  // Only if that much is there, in one statement — as everywhere stock is lowered.
  const lowered = await tx.stockBalance.updateMany({ where: { productId: input.productId, locationId: input.locationId, quantity: { gte: amount } }, data: { quantity: { decrement: amount } } });
  if (lowered.count !== 1) throw new Error("Stock changed while a sale beyond stock was being covered.");
  await tx.stockOwed.update({ where: { id: owed.id }, data: { quantity: { decrement: amount } } });
  const base = await tx.productUnit.findFirst({ where: { productId: input.productId, isBase: true }, select: { name: true } });
  await tx.stockMovement.create({
    data: {
      businessId: businessIdOf(context),
      productId: input.productId,
      locationId: input.locationId,
      type: "SHORTFALL_COVERED",
      quantityDelta: `-${amount}`,
      unitName: base?.name ?? "",
      unitFactor: "1.000",
      unitQuantity: `-${amount}`,
      documentType: "stock_owed",
      documentId: owed.id,
      documentNumber: input.arrivedWith.slice(0, 30),
      userId: context.actor.userId,
      userName: context.actor.name,
      ...(input.at ? { createdAt: input.at } : {}),
    },
  });
  return taking;
}

/**
 * The sales still not covered, worked out from what each place owes: the oldest shortfalls
 * count as covered first, so what remains owed belongs to the newest sales.
 */
export async function unreconciledSales(db: Db | Tx): Promise<
  {
    productId: string;
    productName: string;
    unitName: string;
    locationId: string;
    locationName: string;
    owed: string;
    sales: { saleId: string; receiptNumber: string; at: Date; cashierName: string; short: string }[];
  }[]
> {
  const owing = await db.stockOwed.findMany({
    where: { quantity: { gt: 0 } },
    select: { productId: true, locationId: true, quantity: true, product: { select: { name: true, units: { where: { isBase: true }, select: { name: true } } } }, location: { select: { name: true } } },
  });
  if (owing.length === 0) return [];
  const lines = await db.saleLine.findMany({
    where: { stockShort: { gt: 0 }, OR: owing.map((row) => ({ productId: row.productId, locationId: row.locationId })) },
    orderBy: [{ sale: { createdAt: "desc" } }, { id: "desc" }],
    select: { productId: true, locationId: true, stockShort: true, sale: { select: { id: true, receiptNumber: true, createdAt: true, deviceTime: true, offline: true, cashierName: true } } },
  });
  return owing
    .map((row) => {
      let left = new Decimal(row.quantity.toFixed(3));
      const sales: { saleId: string; receiptNumber: string; at: Date; cashierName: string; short: string }[] = [];
      // Newest first: these are the ones not yet covered.
      for (const line of lines) {
        if (!left.greaterThan(0)) break;
        if (line.productId !== row.productId || line.locationId !== row.locationId) continue;
        const part = Decimal.min(left, new Decimal(line.stockShort.toFixed(3)));
        left = left.minus(part);
        sales.push({
          saleId: line.sale.id,
          receiptNumber: line.sale.receiptNumber,
          at: line.sale.offline && line.sale.deviceTime ? line.sale.deviceTime : line.sale.createdAt,
          cashierName: line.sale.cashierName,
          short: quantityToString(part),
        });
      }
      return {
        productId: row.productId,
        productName: row.product.name,
        unitName: row.product.units[0]?.name ?? "",
        locationId: row.locationId,
        locationName: row.location.name,
        owed: quantityToString(new Decimal(row.quantity.toFixed(3))),
        sales,
      };
    })
    .sort((a, b) => a.productName.localeCompare(b.productName) || a.locationName.localeCompare(b.locationName));
}

/** How many different sales are still not covered. */
export function countUnreconciledSales(rows: Awaited<ReturnType<typeof unreconciledSales>>): number {
  return new Set(rows.flatMap((row) => row.sales.map((sale) => sale.saleId))).size;
}
