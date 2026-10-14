import "server-only";
import { Decimal } from "@/lib/decimal";
import { dateToDay, dayToDate, shopToday } from "@/lib/format";
import { quantityToString } from "@/lib/quantity";
import type { BatchSummary } from "@/lib/batch-order";
import type { AppContext } from "@/server/auth/context";
import { businessDb, businessIdOf } from "@/server/db/scoped";

/**
 * Batches, recorded in the Storeroom only (C73 as changed by C76).
 *
 * A product with batch numbers or expiry dates has batches: everything that came in with the
 * same batch number and expiry date is one batch (`stock_batch`). The STOREROOM keeps exact
 * figures per batch (`stock_batch_balance`); the Shelf keeps only its quantity, as for any
 * product. Every movement into or out of the Storeroom of such a product names its batch and
 * changes that batch's figure in the same transaction — nothing is estimated. Rule held by
 * the tests: the batches in the Storeroom add up to the Storeroom's stock, and no other place
 * has batch figures.
 *
 * Not operations. Everything here runs inside a stock transaction with the product's "turn"
 * already taken.
 */

type Db = ReturnType<typeof businessDb>;
type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];
type Reader = Db | Tx;

export { type BatchSummary, earlierBatchThan } from "@/lib/batch-order";

/** Only products with batch numbers or expiry dates have batches. */
export function hasBatches(product: { tracksBatch: boolean; tracksExpiry: boolean }): boolean {
  return product.tracksBatch || product.tracksExpiry;
}

/** What makes a batch one batch within its product. Capitals and outer spaces in the batch number do not count. */
export function batchKeyOf(batchNumber: string | null, expiryDay: string | null): string {
  return `${(batchNumber ?? "").trim().toLowerCase()}|${expiryDay ?? ""}`;
}

/** The order batches should leave in: earliest expiry first (none at all goes last), then what came in first. */
export function goesFirst(a: { expiryDay: string | null; receivedOn: string; key: string }, b: { expiryDay: string | null; receivedOn: string; key: string }): number {
  if (a.expiryDay !== b.expiryDay) {
    if (a.expiryDay === null) return 1;
    if (b.expiryDay === null) return -1;
    return a.expiryDay.localeCompare(b.expiryDay);
  }
  return a.receivedOn.localeCompare(b.receivedOn) || a.key.localeCompare(b.key);
}

/** The batch with this number and expiry date, made if it does not exist yet. */
export async function batchFor(
  tx: Tx,
  context: AppContext,
  input: { productId: string; batchNumber: string | null; expiryDay: string | null; receivedOn: string },
): Promise<{ id: string; batchNumber: string | null; expiryDay: string | null }> {
  const batchNumber = input.batchNumber?.trim() || null;
  const key = batchKeyOf(batchNumber, input.expiryDay);
  const found = await tx.stockBatch.findFirst({ where: { productId: input.productId, batchKey: key }, select: { id: true, batchNumber: true, expiryDate: true, receivedOn: true } });
  if (found) {
    if (input.receivedOn < dateToDay(found.receivedOn)) await tx.stockBatch.update({ where: { id: found.id }, data: { receivedOn: dayToDate(input.receivedOn)! } });
    return { id: found.id, batchNumber: found.batchNumber, expiryDay: found.expiryDate ? dateToDay(found.expiryDate) : null };
  }
  const created = await tx.stockBatch.create({
    data: {
      businessId: businessIdOf(context),
      productId: input.productId,
      batchNumber,
      expiryDate: input.expiryDay ? dayToDate(input.expiryDay) : null,
      batchKey: key,
      receivedOn: dayToDate(input.receivedOn)!,
    },
    select: { id: true },
  });
  return { id: created.id, batchNumber, expiryDay: input.expiryDay };
}

/** Puts this much into a batch in a place. */
export async function addToBatch(tx: Tx, context: AppContext, input: { batchId: string; productId: string; locationId: string; quantity: Decimal }): Promise<void> {
  if (!input.quantity.greaterThan(0)) return;
  const amount = quantityToString(input.quantity);
  const raised = await tx.stockBatchBalance.updateMany({ where: { batchId: input.batchId, locationId: input.locationId }, data: { quantity: { increment: amount } } });
  if (raised.count === 0) {
    await tx.stockBatchBalance.create({ data: { businessId: businessIdOf(context), batchId: input.batchId, productId: input.productId, locationId: input.locationId, quantity: amount } });
  }
}

/** Takes this much out of a batch, only if that much is there — one statement, like every lowering of stock. */
export async function takeFromBatch(tx: Tx, input: { batchId: string; locationId: string; quantity: Decimal }): Promise<boolean> {
  if (!input.quantity.greaterThan(0)) return true;
  const amount = quantityToString(input.quantity);
  const lowered = await tx.stockBatchBalance.updateMany({ where: { batchId: input.batchId, locationId: input.locationId, quantity: { gte: amount } }, data: { quantity: { decrement: amount } } });
  return lowered.count === 1;
}

/** A product's batches in a place that still hold something, the one that should go first on top. */
export async function batchesIn(db: Reader, productId: string, locationId: string): Promise<BatchSummary[]> {
  const rows = await db.stockBatchBalance.findMany({
    where: { productId, locationId, quantity: { gt: 0 } },
    select: { quantity: true, batch: { select: { id: true, batchNumber: true, expiryDate: true, receivedOn: true, batchKey: true } } },
  });
  return rows
    .map((row) => ({
      id: row.batch.id,
      batchNumber: row.batch.batchNumber,
      expiryDate: row.batch.expiryDate ? dateToDay(row.batch.expiryDate) : null,
      receivedOn: dateToDay(row.batch.receivedOn),
      quantity: row.quantity.toFixed(3),
      order: { expiryDay: row.batch.expiryDate ? dateToDay(row.batch.expiryDate) : null, receivedOn: dateToDay(row.batch.receivedOn), key: row.batch.batchKey },
    }))
    .sort((a, b) => goesFirst(a.order, b.order))
    .map((batch) => ({ id: batch.id, batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, receivedOn: batch.receivedOn, quantity: batch.quantity }));
}

/**
 * Takes this much out of a place's batches, the one that should go first first (for a sale
 * straight from the Storeroom, and stock taken to cover a sale beyond stock). Returns what was
 * taken from each. The batches always add up to the place's stock, so they always suffice.
 */
export async function takeFirstBatches(tx: Tx, input: { productId: string; locationId: string; quantity: Decimal }): Promise<{ batchId: string; quantity: Decimal }[]> {
  const taken: { batchId: string; quantity: Decimal }[] = [];
  let left = input.quantity;
  for (const batch of await batchesIn(tx, input.productId, input.locationId)) {
    if (!left.greaterThan(0)) break;
    const part = Decimal.min(left, batch.quantity);
    if (!(await takeFromBatch(tx, { batchId: batch.id, locationId: input.locationId, quantity: part }))) throw new Error("A batch changed while stock was being taken from it.");
    taken.push({ batchId: batch.id, quantity: part });
    left = left.minus(part);
  }
  if (left.greaterThan(0)) throw new Error("The Storeroom's batches do not add up to its stock.");
  return taken;
}

/**
 * Makes sure a product's Storeroom batches add up to the Storeroom's stock before anything
 * changes it. They always do — except for stock that was there before batches were recorded
 * (C76 (4)). That stock is split into batches once, on the rule that what came in first went
 * first: the batches still held are those that came in last. Batch figures anywhere other than
 * the Storeroom (left over from C75) are removed. Returns whether the product has batches.
 */
export async function settleStoreroomBatches(tx: Tx, context: AppContext, productId: string): Promise<boolean> {
  const product = await tx.product.findFirst({ where: { id: productId }, select: { tracksBatch: true, tracksExpiry: true } });
  if (!product || !hasBatches(product)) return false;
  const storeroom = await tx.location.findFirst({ where: { kind: "STOREROOM" }, select: { id: true } });
  if (!storeroom) return true;
  await tx.stockBatchBalance.deleteMany({ where: { productId, locationId: { not: storeroom.id } } });

  const balance = await tx.stockBalance.findFirst({ where: { productId, locationId: storeroom.id }, select: { quantity: true } });
  const held = new Decimal(balance?.quantity.toFixed(3) ?? "0");
  const inBatches = await tx.stockBatchBalance.aggregate({ where: { productId, locationId: storeroom.id }, _sum: { quantity: true } });
  const recorded = new Decimal(inBatches._sum.quantity?.toFixed(3) ?? "0");
  if (held.equals(recorded)) return true;

  if (recorded.greaterThan(held)) {
    // Never expected; take the surplus from the batches that go first so that the figures agree again.
    await takeFirstBatches(tx, { productId, locationId: storeroom.id, quantity: recorded.minus(held) });
    return true;
  }

  // Stock from before batches were recorded: given to the batches that came in last, as far as their deliveries go.
  let missing = held.minus(recorded);
  const lines = await tx.goodsReceiptLine.findMany({ where: { productId }, select: { baseQuantity: true, batchNumber: true, expiryDate: true, receipt: { select: { receivedOn: true } } } });
  const candidates = new Map<string, { key: string; batchNumber: string | null; expiryDay: string | null; receivedOn: string; received: Decimal }>();
  for (const line of lines) {
    const expiryDay = line.expiryDate ? dateToDay(line.expiryDate) : null;
    const key = batchKeyOf(line.batchNumber, expiryDay);
    const receivedOn = dateToDay(line.receipt.receivedOn);
    const known = candidates.get(key);
    if (known) {
      known.received = known.received.plus(line.baseQuantity.toFixed(3));
      if (receivedOn < known.receivedOn) known.receivedOn = receivedOn;
    } else {
      candidates.set(key, { key, batchNumber: line.batchNumber?.trim() || null, expiryDay, receivedOn, received: new Decimal(line.baseQuantity.toFixed(3)) });
    }
  }
  const already = new Map((await batchesIn(tx, productId, storeroom.id)).map((batch) => [batch.id, new Decimal(batch.quantity)]));
  for (const candidate of [...candidates.values()].sort(goesFirst).reverse()) {
    if (!missing.greaterThan(0)) break;
    const batch = await batchFor(tx, context, { productId, batchNumber: candidate.batchNumber, expiryDay: candidate.expiryDay, receivedOn: candidate.receivedOn });
    const room = candidate.received.minus(already.get(batch.id) ?? 0);
    const part = Decimal.min(missing, Decimal.max(room, 0));
    if (!part.greaterThan(0)) continue;
    await addToBatch(tx, context, { batchId: batch.id, productId, locationId: storeroom.id, quantity: part });
    missing = missing.minus(part);
  }
  if (missing.greaterThan(0)) {
    // More than every delivery on record brought in: it belongs to no batch on record.
    const none = await batchFor(tx, context, { productId, batchNumber: null, expiryDay: null, receivedOn: shopToday() });
    await addToBatch(tx, context, { batchId: none.id, productId, locationId: storeroom.id, quantity: missing });
  }
  return true;
}

/** True when a product's Storeroom batches no longer add up to the Storeroom's stock (stock from before batches were recorded). */
export async function batchesAreBehind(db: Reader, productId: string): Promise<boolean> {
  const storeroom = await db.location.findFirst({ where: { kind: "STOREROOM" }, select: { id: true } });
  if (!storeroom) return false;
  const [balance, inBatches, elsewhere] = await Promise.all([
    db.stockBalance.findFirst({ where: { productId, locationId: storeroom.id }, select: { quantity: true } }),
    db.stockBatchBalance.aggregate({ where: { productId, locationId: storeroom.id }, _sum: { quantity: true } }),
    db.stockBatchBalance.count({ where: { productId, locationId: { not: storeroom.id } } }),
  ]);
  return elsewhere > 0 || !new Decimal(balance?.quantity.toFixed(3) ?? "0").equals(inBatches._sum.quantity?.toFixed(3) ?? "0");
}

/**
 * What the transfer and adjustment screens offer for products with batches: the batches each
 * holds in the Storeroom (the one that should go first on top), and every batch it has had (for
 * goods going back in). Stock from before batches were recorded is split into batches once
 * first, under each product's turn. Called by operations that have already checked permission.
 */
export async function storeroomBatchChoices(
  context: AppContext,
  products: { id: string; tracksBatch: boolean; tracksExpiry: boolean }[],
  storeroomId: string | null,
): Promise<{ batchesOf: Map<string, BatchSummary[]>; knownBatches: Map<string, { id: string; batchNumber: string | null; expiryDate: string | null }[]> }> {
  const db = businessDb(context);
  const batched = products.filter((product) => hasBatches(product));
  const knownBatches = new Map<string, { id: string; batchNumber: string | null; expiryDate: string | null }[]>();
  if (!storeroomId || batched.length === 0) return { batchesOf: new Map(), knownBatches };
  const behind = (await Promise.all(batched.map(async (product) => ((await batchesAreBehind(db, product.id)) ? product.id : null)))).filter((id): id is string => id !== null);
  if (behind.length > 0) {
    await db.$transaction(
      async (tx) => {
        for (const productId of behind.sort()) {
          await tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() }, select: { id: true } });
          await settleStoreroomBatches(tx, context, productId);
        }
      },
      { isolationLevel: "ReadCommitted" },
    );
  }
  const batchesOf = new Map(await Promise.all(batched.map(async (product) => [product.id, await batchesIn(db, product.id, storeroomId)] as const)));
  const rows = await db.stockBatch.findMany({
    where: { productId: { in: batched.map((product) => product.id) } },
    orderBy: [{ expiryDate: "asc" }, { receivedOn: "asc" }],
    select: { id: true, productId: true, batchNumber: true, expiryDate: true },
  });
  for (const row of rows) {
    const list = knownBatches.get(row.productId) ?? [];
    list.push({ id: row.id, batchNumber: row.batchNumber, expiryDate: row.expiryDate ? dateToDay(row.expiryDate) : null });
    knownBatches.set(row.productId, list);
  }
  return { batchesOf, knownBatches };
}
