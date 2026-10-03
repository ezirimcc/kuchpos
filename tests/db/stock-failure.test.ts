import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { receiveGoods } from "@/server/business/stock";
import { getDb } from "@/server/db/client";
import { createWorld, expectBalancesMatchMovements, type World } from "../support/world";

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
    expect((await db.business.findUniqueOrThrow({ where: { id: world.a.id } })).nextGoodsReceiptNumber).toBe(1);
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
