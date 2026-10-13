import "server-only";
import { Decimal } from "@/lib/decimal";
import { dateToDay, dayToDate, shopToday } from "@/lib/format";
import { quantityToString } from "@/lib/quantity";
import type { AppContext } from "@/server/auth/context";
import { type businessDb, businessIdOf } from "@/server/db/scoped";

/**
 * Stock counted batch by batch (C73), step 1 of 4 (C75).
 *
 * A product with batch numbers or expiry dates has batches: everything that came in with the
 * same batch number and expiry date is one batch. `stock_balance` stays the figure that
 * everything else uses; `stock_batch_balance` says which batches that figure is made of, and
 * for such a product the two always add up to the same in every place (a test rule).
 *
 * In this step the batches are WORKED OUT, not recorded movement by movement: what is left of
 * each batch follows from the product's deliveries and its stock now, on the rule that what
 * goes first is sold first — the earliest expiry date, and without one (or with the same one)
 * what came in first. Which batch stands where is an estimate until transfers carry a batch
 * (step 2): the batches that go first are taken to be on the Shelf. `refreshBatches` redoes the
 * sum, and is called at the end of every transaction that changes a product's stock.
 *
 * Not operations. `refreshBatches` must run inside a stock transaction with each product's
 * "turn" already taken.
 */

type Db = ReturnType<typeof businessDb>;
type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

/** What makes a batch one batch within its product. Capitals and outer spaces in the batch number do not count. */
export function batchKeyOf(batchNumber: string | null, expiryDay: string | null): string {
  return `${(batchNumber ?? "").trim().toLowerCase()}|${expiryDay ?? ""}`;
}

type Candidate = { key: string; batchNumber: string | null; expiryDay: string | null; receivedOn: string; quantity: Decimal };

/** The order batches leave in: earliest expiry first (none at all goes last), then what came in first. */
export function goesFirst(a: { expiryDay: string | null; receivedOn: string; key: string }, b: { expiryDay: string | null; receivedOn: string; key: string }): number {
  if (a.expiryDay !== b.expiryDay) {
    if (a.expiryDay === null) return 1;
    if (b.expiryDay === null) return -1;
    return a.expiryDay.localeCompare(b.expiryDay);
  }
  return a.receivedOn.localeCompare(b.receivedOn) || a.key.localeCompare(b.key);
}

/**
 * Works out again what is left of each batch of these products, and where. Products without
 * batch numbers or expiry dates are skipped.
 */
export async function refreshBatches(tx: Tx, context: AppContext, productIds: string[]): Promise<void> {
  const businessId = businessIdOf(context);
  for (const productId of [...new Set(productIds)].sort()) {
    const product = await tx.product.findFirst({ where: { id: productId }, select: { tracksBatch: true, tracksExpiry: true } });
    if (!product || (!product.tracksBatch && !product.tracksExpiry)) continue;

    const [lines, balances] = await Promise.all([
      tx.goodsReceiptLine.findMany({ where: { productId }, select: { baseQuantity: true, batchNumber: true, expiryDate: true, receipt: { select: { receivedOn: true } } } }),
      tx.stockBalance.findMany({ where: { productId, quantity: { gt: 0 } }, select: { locationId: true, quantity: true, location: { select: { kind: true } } } }),
    ]);

    // Everything that ever came in, gathered into batches.
    const batches = new Map<string, Candidate>();
    for (const line of lines) {
      const expiryDay = line.expiryDate ? dateToDay(line.expiryDate) : null;
      const key = batchKeyOf(line.batchNumber, expiryDay);
      const receivedOn = dateToDay(line.receipt.receivedOn);
      const batch = batches.get(key);
      if (batch) {
        batch.quantity = batch.quantity.plus(line.baseQuantity.toFixed(3));
        if (receivedOn < batch.receivedOn) batch.receivedOn = receivedOn;
      } else {
        batches.set(key, { key, batchNumber: line.batchNumber?.trim() || null, expiryDay, receivedOn, quantity: new Decimal(line.baseQuantity.toFixed(3)) });
      }
    }
    const held = balances.reduce((sum, balance) => sum.plus(balance.quantity.toFixed(3)), new Decimal(0));
    const received = [...batches.values()].reduce((sum, batch) => sum.plus(batch.quantity), new Decimal(0));
    // More in stock than ever came in by delivery (found in a count, say): it belongs to no batch on record.
    if (held.greaterThan(received)) {
      const none = batchKeyOf(null, null);
      const extra = held.minus(received);
      const batch = batches.get(none);
      if (batch) batch.quantity = batch.quantity.plus(extra);
      else batches.set(none, { key: none, batchNumber: null, expiryDay: null, receivedOn: shopToday(), quantity: extra });
    }

    // What has gone (sold, written off, moved out for good) went from the batches that go first.
    const order = [...batches.values()].sort(goesFirst);
    let gone = Decimal.max(received.minus(held), 0);
    for (const batch of order) {
      const out = Decimal.min(gone, batch.quantity);
      batch.quantity = batch.quantity.minus(out);
      gone = gone.minus(out);
    }
    const left = order.filter((batch) => batch.quantity.greaterThan(0));

    // Where each stands: the Shelf is filled from the batches that go first, the other places from the rest.
    const places = [...balances].sort((a, b) => Number(a.location.kind !== "SHELF") - Number(b.location.kind !== "SHELF") || a.locationId.localeCompare(b.locationId));
    const rows: { key: string; locationId: string; quantity: Decimal }[] = [];
    for (const place of places) {
      let room = new Decimal(place.quantity.toFixed(3));
      for (const batch of left) {
        if (!room.greaterThan(0)) break;
        const here = Decimal.min(room, batch.quantity);
        if (!here.greaterThan(0)) continue;
        batch.quantity = batch.quantity.minus(here);
        room = room.minus(here);
        rows.push({ key: batch.key, locationId: place.locationId, quantity: here });
      }
    }

    // The batches themselves are kept (later steps refer to them); what each holds is written afresh.
    const known = new Map((await tx.stockBatch.findMany({ where: { productId }, select: { id: true, batchKey: true, receivedOn: true } })).map((batch) => [batch.batchKey, batch]));
    for (const key of new Set(rows.map((row) => row.key))) {
      const batch = batches.get(key)!;
      const saved = known.get(key);
      if (!saved) {
        const created = await tx.stockBatch.create({
          data: { businessId, productId, batchNumber: batch.batchNumber, expiryDate: batch.expiryDay ? dayToDate(batch.expiryDay) : null, batchKey: key, receivedOn: dayToDate(batch.receivedOn)! },
          select: { id: true, batchKey: true, receivedOn: true },
        });
        known.set(key, created);
      } else if (dateToDay(saved.receivedOn) !== batch.receivedOn && key !== batchKeyOf(null, null)) {
        // A correction can change the day a delivery came in.
        await tx.stockBatch.update({ where: { id: saved.id }, data: { receivedOn: dayToDate(batch.receivedOn)! } });
      }
    }
    await tx.stockBatchBalance.deleteMany({ where: { productId } });
    if (rows.length > 0) {
      await tx.stockBatchBalance.createMany({
        data: rows.map((row) => ({ businessId, batchId: known.get(row.key)!.id, productId, locationId: row.locationId, quantity: quantityToString(row.quantity) })),
      });
    }
  }
}

/** True when a product's batches no longer add up to its stock somewhere (stock that was there before batches were counted). */
export async function batchesAreBehind(db: Db | Tx, productId: string): Promise<boolean> {
  const [balances, batches] = await Promise.all([
    db.stockBalance.findMany({ where: { productId }, select: { locationId: true, quantity: true } }),
    db.stockBatchBalance.groupBy({ by: ["locationId"], where: { productId }, _sum: { quantity: true } }),
  ]);
  const inBatches = new Map(batches.map((group) => [group.locationId, group._sum.quantity?.toFixed(3) ?? "0.000"]));
  const places = new Set([...balances.map((balance) => balance.locationId), ...inBatches.keys()]);
  for (const locationId of places) {
    const held = balances.find((balance) => balance.locationId === locationId)?.quantity.toFixed(3) ?? "0.000";
    if (!new Decimal(held).equals(inBatches.get(locationId) ?? "0")) return true;
  }
  return false;
}
