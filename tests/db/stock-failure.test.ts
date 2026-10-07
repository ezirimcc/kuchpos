import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { correctReceipt, getCorrectionOptions, getReceiptHistory } from "@/server/business/receipt-corrections";
import { getReceipt, receiveGoods } from "@/server/business/stock";
import { transferStock } from "@/server/business/transfers";
import { adjustFromCount, decideAdjustment, getAdjustment, recordAdjustment } from "@/server/business/adjustments";
import { submitCount } from "@/server/business/counts";
import { getDb } from "@/server/db/client";
import { createWorld, expectBalancesMatchMovements, nextDocumentNumber, type World } from "../support/world";

/**
 * Forces a failure at the very last step of saving a delivery — after the document, its
 * lines, the balances and the movements have all been written — and checks that every
 * one of them is undone.
 */
const failure = vi.hoisted(() => ({ on: false }));

vi.mock("@/server/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/activity")>();
  return {
    ...actual,
    activityRow: (...args: Parameters<typeof actual.activityRow>) => {
      if (failure.on) throw new Error("Simulated failure while saving");
      return actual.activityRow(...args);
    },
  };
});

let world: World;
beforeEach(async () => {
  failure.on = false;
  world = await createWorld();
});

function delivery() {
  return {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.storeroomId,
    lines: [
      { productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "4", unitCost: "700" },
      { productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "3", unitCost: "75" },
    ],
  };
}

describe("a failure halfway through saving a delivery", () => {
  it("leaves no delivery, no lines, no movements, no stock and no change to the average cost", async () => {
    const db = getDb();
    failure.on = true;
    await expect(receiveGoods(world.a.as.ADMIN, delivery())).rejects.toThrow("Simulated failure while saving");

    expect(await db.goodsReceipt.count()).toBe(0);
    expect(await db.goodsReceiptLine.count()).toBe(0);
    expect(await db.stockMovement.count()).toBe(0);
    expect(await db.stockBalance.count()).toBe(0);
    expect((await db.product.findUniqueOrThrow({ where: { id: world.a.product.id } })).averageCost.toFixed(4)).toBe("0.0000");
    expect(await nextDocumentNumber(world.a.id, "GOODS_RECEIPT")).toBe(1);
    await expectBalancesMatchMovements();
  });

  it("does not waste a delivery number: the next successful delivery is number 1", async () => {
    failure.on = true;
    await expect(receiveGoods(world.a.as.ADMIN, delivery())).rejects.toThrow();
    failure.on = false;

    const saved = await receiveGoods(world.a.as.ADMIN, delivery());
    expect(saved.number).toBe(1);
    expect(await getDb().stockMovement.count()).toBe(2);
    await expectBalancesMatchMovements();
  });

  it("can be retried with the same request and then saves exactly once", async () => {
    const request = delivery();
    failure.on = true;
    await expect(receiveGoods(world.a.as.ADMIN, request)).rejects.toThrow();
    failure.on = false;

    const saved = await receiveGoods(world.a.as.ADMIN, request);
    const again = await receiveGoods(world.a.as.ADMIN, request);
    expect(saved.alreadySaved).toBe(false);
    expect(again.alreadySaved).toBe(true);
    expect(await getDb().goodsReceipt.count()).toBe(1);
    await expectBalancesMatchMovements();
  });
});

/**
 * The same for a correction: the failure comes after the delivery, its new snapshot, the
 * change records, the balances, the average cost and the movements have all been written.
 */
describe("a failure halfway through saving a correction", () => {
  async function snapshot() {
    const db = getDb();
    return JSON.stringify({
      receipts: await db.goodsReceipt.findMany(),
      lines: await db.goodsReceiptLine.findMany({ orderBy: { lineNumber: "asc" } }),
      versions: await db.goodsReceiptVersion.findMany(),
      versionLines: await db.goodsReceiptVersionLine.findMany({ orderBy: { lineNumber: "asc" } }),
      changes: await db.goodsReceiptChange.findMany(),
      movements: await db.stockMovement.findMany({ orderBy: { id: "asc" } }),
      balances: await db.stockBalance.findMany({ orderBy: { id: "asc" } }),
      averageCost: (await db.product.findUniqueOrThrow({ where: { id: world.a.product.id } })).averageCost,
      activity: await db.activityLog.count(),
    });
  }

  async function correction(receiptId: string) {
    const { receipt } = await getCorrectionOptions(world.a.as.ADMIN, { receiptId });
    return {
      receiptId,
      requestId: randomUUID(),
      expectedVersion: receipt.version,
      reason: "Counted the goods again",
      supplierId: receipt.supplierId,
      // Moved to the Shelf, one line changed in quantity and cost, one removed, one added.
      locationId: world.a.shelfId,
      receivedOn: receipt.receivedOn,
      invoiceNumber: "INV-1",
      note: "",
      lines: [
        { ...receipt.lines[0], quantity: "9", unitCost: "650" },
        { lineNumber: null, productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "7", unitCost: "80" },
      ],
    };
  }

  it("leaves the delivery, its history, the stock and the average cost exactly as they were", async () => {
    const { id } = await receiveGoods(world.a.as.ADMIN, delivery());
    const before = await snapshot();

    failure.on = true;
    await expect(correctReceipt(world.a.as.ADMIN, await correction(id))).rejects.toThrow("Simulated failure while saving");

    expect(await snapshot()).toBe(before);
    expect((await getReceipt(world.a.as.ADMIN, { receiptId: id })).version).toBe(1);
    expect(await getReceiptHistory(world.a.as.ADMIN, { receiptId: id })).toHaveLength(1);
    await expectBalancesMatchMovements();
  });

  it("can be sent again with the same request and is then saved exactly once", async () => {
    const { id } = await receiveGoods(world.a.as.ADMIN, delivery());
    const request = await correction(id);

    failure.on = true;
    await expect(correctReceipt(world.a.as.ADMIN, request)).rejects.toThrow();
    failure.on = false;

    expect(await correctReceipt(world.a.as.ADMIN, request)).toMatchObject({ version: 2, alreadySaved: false });
    expect(await correctReceipt(world.a.as.ADMIN, request)).toMatchObject({ version: 2, alreadySaved: true });
    expect(await getReceiptHistory(world.a.as.ADMIN, { receiptId: id })).toHaveLength(2);
    // 4 packs + 3 singles = 43 in the Storeroom became 9 packs + 7 singles = 97 on the Shelf.
    const balances = await getDb().stockBalance.findMany({ where: { productId: world.a.product.id } });
    expect(balances.map((balance) => balance.quantity.toFixed(3)).sort()).toEqual(["0.000", "97.000"]);
    await expectBalancesMatchMovements();
  });
});

/** And for a transfer: the failure comes after the document, both balances and all movements are written. */
describe("a failure halfway through saving a transfer", () => {
  const transfer = () => ({
    requestId: randomUUID(),
    fromLocationId: world.a.storeroomId,
    toLocationId: world.a.shelfId,
    lines: [
      { productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "2" },
      { productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "3" },
    ],
  });

  it("leaves no transfer, no movements, and all the stock where it was", async () => {
    await receiveGoods(world.a.as.ADMIN, delivery());
    const db = getDb();
    const balances = async () => JSON.stringify(await db.stockBalance.findMany({ orderBy: { id: "asc" } }));
    const before = await balances();

    failure.on = true;
    await expect(transferStock(world.a.as.ADMIN, transfer())).rejects.toThrow("Simulated failure while saving");

    expect(await db.stockTransfer.count()).toBe(0);
    expect(await db.stockTransferLine.count()).toBe(0);
    expect(await db.stockMovement.count({ where: { type: { in: ["TRANSFER_OUT", "TRANSFER_IN"] } } })).toBe(0);
    expect(await balances()).toBe(before);
    expect(await nextDocumentNumber(world.a.id, "STOCK_TRANSFER")).toBe(1);
    await expectBalancesMatchMovements();
  });

  it("can be sent again with the same request and is then saved exactly once, as number 1", async () => {
    await receiveGoods(world.a.as.ADMIN, delivery());
    const request = transfer();
    failure.on = true;
    await expect(transferStock(world.a.as.ADMIN, request)).rejects.toThrow();
    failure.on = false;

    expect(await transferStock(world.a.as.ADMIN, request)).toMatchObject({ number: 1, alreadySaved: false });
    expect(await transferStock(world.a.as.ADMIN, request)).toMatchObject({ number: 1, alreadySaved: true });
    const shelf = await getDb().stockBalance.findFirstOrThrow({ where: { productId: world.a.product.id, locationId: world.a.shelfId } });
    expect(shelf.quantity.toFixed(3)).toBe("23.000");
    await expectBalancesMatchMovements();
  });
});

/** And for counts, adjustments and approvals. */
describe("a failure halfway through a count, an adjustment or an approval", () => {
  const state = async () => {
    const db = getDb();
    return JSON.stringify({
      counts: await db.stockCount.count(),
      countLines: await db.stockCountLine.count(),
      adjustments: await db.stockAdjustment.count(),
      adjustmentLines: await db.stockAdjustmentLine.count(),
      decisions: await db.stockAdjustmentDecision.count(),
      movements: await db.stockMovement.count(),
      balances: await db.stockBalance.findMany({ orderBy: { id: "asc" } }),
      numbers: [await nextDocumentNumber(world.a.id, "STOCK_COUNT"), await nextDocumentNumber(world.a.id, "STOCK_ADJUSTMENT")],
    });
  };
  const line = () => ({ productId: world.a.product.id, unitId: world.a.product.baseUnitId, direction: "remove", quantity: "3", reason: "DAMAGED" });
  const adjusting = () => ({ requestId: randomUUID(), locationId: world.a.storeroomId, lines: [line()] });
  const counting = () => ({
    requestId: randomUUID(),
    locationId: world.a.storeroomId,
    lines: [{ productId: world.a.product.id, entries: [{ unitId: world.a.product.baseUnitId, quantity: "40" }] }],
  });

  it("leaves nothing behind, and each can then be done again", async () => {
    await receiveGoods(world.a.as.ADMIN, delivery());
    // Something waiting for approval, and a count, saved before the failures start.
    const waiting = await recordAdjustment(world.a.as.STOREKEEPER, adjusting());
    const counted = await submitCount(world.a.as.ADMIN, counting());
    const before = await state();

    failure.on = true;
    const direct = adjusting();
    const fromCount = { requestId: randomUUID(), countId: counted.id, reasons: [{ lineNumber: 1, reason: "MISSING" }] };
    await expect(submitCount(world.a.as.ADMIN, counting())).rejects.toThrow("Simulated failure while saving");
    await expect(recordAdjustment(world.a.as.MANAGER, direct)).rejects.toThrow("Simulated failure while saving");
    await expect(adjustFromCount(world.a.as.MANAGER, fromCount)).rejects.toThrow("Simulated failure while saving");
    await expect(decideAdjustment(world.a.as.MANAGER, { adjustmentId: waiting.id, outcome: "APPLIED" })).rejects.toThrow("Simulated failure while saving");
    await expect(decideAdjustment(world.a.as.MANAGER, { adjustmentId: waiting.id, outcome: "REJECTED", note: "Not agreed" })).rejects.toThrow("Simulated failure while saving");

    expect(await state()).toBe(before);
    expect((await getAdjustment(world.a.as.ADMIN, { adjustmentId: waiting.id })).status).toBe("PENDING");
    await expectBalancesMatchMovements();

    failure.on = false;
    expect(await recordAdjustment(world.a.as.MANAGER, direct)).toMatchObject({ number: 2, status: "APPLIED", alreadySaved: false });
    expect(await adjustFromCount(world.a.as.MANAGER, fromCount)).toMatchObject({ number: 3, status: "APPLIED" });
    expect(await decideAdjustment(world.a.as.MANAGER, { adjustmentId: waiting.id, outcome: "APPLIED" })).toMatchObject({ alreadyDecided: false });
    // 43 held; counted 40 (−3), then −3 direct, then −3 approved.
    const storeroom = await getDb().stockBalance.findFirstOrThrow({ where: { productId: world.a.product.id, locationId: world.a.storeroomId } });
    expect(storeroom.quantity.toFixed(3)).toBe("34.000");
    await expectBalancesMatchMovements();
  });
});
