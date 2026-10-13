import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordAdjustment } from "@/server/business/adjustments";
import { getDashboard } from "@/server/business/dashboard";
import { getOfflineKit } from "@/server/business/offline";
import { getStockMovements } from "@/server/business/reports";
import { postReturn } from "@/server/business/returns";
import { cancelSale, postOfflineSale, postSale } from "@/server/business/sales";
import { listStockOnHand, listStockOwed, receiveGoods } from "@/server/business/stock";
import { openTill } from "@/server/business/till";
import { transferStock } from "@/server/business/transfers";
import { getDb } from "@/server/db/client";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, type World } from "../support/world";

/**
 * Sales beyond the stock on record leave stock "owed" (C72). The owner's rule is "negative
 * stock that is settled by the next transfer, delivery or adjustment"; the database keeps
 * every balance at zero or more and holds the minus part apart. These tests check that the
 * two read the same: after each event, what the place holds less what it owes is exactly
 * what plain negative arithmetic gives.
 *
 * Business A starts each test with 10 singles on the Shelf and 50 in the Storeroom.
 */

let world: World;
let pass = "";
let receiptCount = 0;

beforeEach(async () => {
  world = await createWorld();
  receiptCount = 0;
  const receive = (locationId: string, quantity: string) =>
    receiveGoods(world.a.as.ADMIN, { requestId: randomUUID(), supplierId: world.a.supplierId, locationId, lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity, unitCost: "50" }] });
  await receive(world.a.shelfId, "10");
  await receive(world.a.storeroomId, "50");
  await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "0" });
  pass = (await getOfflineKit(world.a.as.CASHIER)).pass;
});

afterEach(async () => {
  // Includes the owed-stock rule: owed = shortfalls less what was covered, and never stock held while some is owed.
  await expectBalancesMatchMovements();
  await expectCustomerBalancesMatchEntries();
});

/** A sale of singles made without internet at T1, paid in cash. */
async function sellOffline(singles: number) {
  receiptCount += 1;
  const total = `${singles * 100}.00`;
  return postOfflineSale(world.a.as.CASHIER, {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    pass,
    receiptNumber: `T1-F${String(receiptCount).padStart(6, "0")}`,
    deviceTime: new Date(Date.now() - 60_000 + receiptCount * 1000).toISOString(),
    expectedTotal: total,
    payments: [{ methodId: world.a.cashMethodId, amount: total }],
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: String(singles), unitPrice: "100.00" }],
  });
}
const held = async (locationId: string) => (await getDb().stockBalance.findFirst({ where: { productId: world.a.product.id, locationId } }))?.quantity.toFixed(3) ?? "0.000";
const owed = async (locationId = world.a.shelfId) => (await getDb().stockOwed.findFirst({ where: { productId: world.a.product.id, locationId } }))?.quantity.toFixed(3) ?? "0.000";
/** Held and owed on the Shelf, then held in the Storeroom. */
const state = async () => [await held(world.a.shelfId), await owed(), await held(world.a.storeroomId)];
const toShelf = (quantity: string) =>
  transferStock(world.a.as.MANAGER, { requestId: randomUUID(), fromLocationId: world.a.storeroomId, toLocationId: world.a.shelfId, lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity }] });

describe("a sale beyond the stock on record", () => {
  it("leaves the place owing the rest, shown as a minus, with a bright count for managers", async () => {
    const sale = await sellOffline(13);
    // 10 − 13 = −3: nothing held, 3 owed.
    expect(await state()).toEqual(["0.000", "3.000", "50.000"]);

    const list = await listStockOwed(world.a.as.MANAGER);
    expect(list.salesCount).toBe(1);
    expect(list.rows).toEqual([
      expect.objectContaining({ productName: "A Seed Sachet", locationName: "Shelf", unitName: "single", owed: "3.000", sales: [expect.objectContaining({ saleId: sale.id, receiptNumber: "T1-F000001", short: "3.000", cashierName: "Test a.cashier" })] }),
    ]);
    const onHand = (await listStockOnHand(world.a.as.CASHIER)).rows.find((row) => row.productId === world.a.product.id)!;
    expect(onHand).toMatchObject({ total: "50.000", owed: "3.000", owedByLocation: { [world.a.shelfId]: "3.000" } });

    // Admin, manager and owner are told on the home page; others are not.
    for (const actor of [world.a.as.ADMIN, world.a.as.MANAGER, world.ownerInA]) expect((await getDashboard(actor)).unreconciledSales).toBe(1);
    for (const role of ["ACCOUNTANT", "CASHIER", "STOREKEEPER"] as const) expect((await getDashboard(world.a.as[role])).unreconciledSales, role).toBeNull();
    await expect(listStockOwed(world.a.as.CASHIER)).rejects.toBeInstanceOf(ForbiddenError);
    // Business B has sold nothing beyond its stock.
    expect(await listStockOwed(world.b.as.ADMIN)).toEqual({ rows: [], salesCount: 0 });
    expect((await getDashboard(world.b.as.ADMIN)).unreconciledSales).toBe(0);

    // Online, selling what is not there is still refused; and the database still refuses a quantity below zero.
    await expect(
      postSale(world.a.as.CASHIER, { requestId: randomUUID(), terminalId: world.a.terminalId, expectedTotal: "100.00", payments: [{ methodId: world.a.cashMethodId, amount: "100.00" }], lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "1", unitPrice: "100.00" }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(getDb().stockBalance.updateMany({ where: { productId: world.a.product.id, locationId: world.a.shelfId }, data: { quantity: "-1" } })).rejects.toThrow();
    await expect(getDb().stockOwed.updateMany({ where: { productId: world.a.product.id }, data: { quantity: "-1" } })).rejects.toThrow();
  });

  it("is settled by a transfer into that place: −3 + 5 = 2", async () => {
    await sellOffline(13);
    const transfer = await toShelf("5");
    expect(await state()).toEqual(["2.000", "0.000", "45.000"]);
    expect(await listStockOwed(world.a.as.MANAGER)).toEqual({ rows: [], salesCount: 0 });
    expect((await getDashboard(world.a.as.MANAGER)).unreconciledSales).toBe(0);

    // The transfer is recorded as it was made; the covering has a line of its own, naming the transfer.
    const movements = await getDb().stockMovement.findMany({ where: { locationId: world.a.shelfId, createdAt: { gte: new Date(Date.now() - 30_000) }, type: { in: ["TRANSFER_IN", "SHORTFALL_COVERED"] } }, orderBy: { type: "asc" } });
    expect(movements.map((movement) => [movement.type, movement.quantityDelta.toFixed(3), movement.documentNumber, movement.unitName, movement.userName])).toEqual([
      ["TRANSFER_IN", "5.000", "TR-000001", "single", "Test a.manager"],
      ["SHORTFALL_COVERED", "-3.000", "TR-000001", "single", "Test a.manager"],
    ]);
    expect(transfer.number).toBe(1);
    const report = await getStockMovements(world.a.as.ADMIN, { type: "SHORTFALL_COVERED" });
    expect(report.rows.map((row) => [row.type, row.quantity, row.documentNumber])).toEqual([["SHORTFALL_COVERED", "-3.000", "TR-000001"]]);
  });

  it("is settled bit by bit, by whatever arrives: a transfer, then a delivery; or an adjustment", async () => {
    await sellOffline(13);
    // −3 + 2 = −1
    await toShelf("2");
    expect(await state()).toEqual(["0.000", "1.000", "48.000"]);
    expect((await listStockOwed(world.a.as.MANAGER)).rows[0]).toMatchObject({ owed: "1.000", sales: [expect.objectContaining({ short: "1.000" })] });
    // −1 + 10 = 9
    await receiveGoods(world.a.as.STOREKEEPER, { requestId: randomUUID(), supplierId: world.a.supplierId, locationId: world.a.shelfId, lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "10", unitCost: "50" }] });
    expect(await state()).toEqual(["9.000", "0.000", "48.000"]);

    // A delivery into the OTHER place covers nothing on the Shelf.
    await sellOffline(11);
    expect(await state()).toEqual(["0.000", "2.000", "48.000"]);
    await receiveGoods(world.a.as.STOREKEEPER, { requestId: randomUUID(), supplierId: world.a.supplierId, locationId: world.a.storeroomId, lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "5", unitCost: "50" }] });
    expect(await state()).toEqual(["0.000", "2.000", "53.000"]);
    // An adjustment upwards on the Shelf does: −2 + 2 = 0.
    await recordAdjustment(world.a.as.MANAGER, { requestId: randomUUID(), locationId: world.a.shelfId, note: "", lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, direction: "add", quantity: "2", reason: "FOUND" }] });
    expect(await state()).toEqual(["0.000", "0.000", "53.000"]);
    expect((await getDb().stockMovement.findMany({ where: { type: "SHORTFALL_COVERED" }, orderBy: { createdAt: "asc" } })).map((movement) => [movement.quantityDelta.toFixed(3), movement.documentNumber])).toEqual([
      ["-2.000", "TR-000001"],
      ["-1.000", "GR-000003"],
      ["-2.000", "AD-000001"],
    ]);
    // The average cost was never upset by any of it.
    expect((await getDb().product.findUniqueOrThrow({ where: { id: world.a.product.id } })).averageCost.toFixed(4)).toBe("50.0000");
  });

  it("counts the exact number of sales not yet covered: the oldest are covered first", async () => {
    const first = await sellOffline(13); // −3
    const second = await sellOffline(4); // −7
    const third = await sellOffline(2); // −9
    expect(await state()).toEqual(["0.000", "9.000", "50.000"]);
    expect((await getDashboard(world.a.as.MANAGER)).unreconciledSales).toBe(3);

    // 5 arrive: the first sale's 3 and 2 of the second's 4 are covered.
    await toShelf("5");
    expect(await state()).toEqual(["0.000", "4.000", "45.000"]);
    const list = await listStockOwed(world.a.as.MANAGER);
    expect(list.salesCount).toBe(2);
    expect(list.rows[0].sales.map((sale) => [sale.saleId, sale.short])).toEqual([[third.id, "2.000"], [second.id, "2.000"]]);
    expect(list.rows[0].sales.some((sale) => sale.saleId === first.id)).toBe(false);

    await toShelf("4");
    expect(await state()).toEqual(["0.000", "0.000", "41.000"]);
    expect((await getDashboard(world.a.as.MANAGER)).unreconciledSales).toBe(0);
  });

  it("is undone by cancelling the sale, and reduced by goods coming back", async () => {
    // Cancelled the same day: 10 − 13 + 13 = 10.
    const gone = await sellOffline(13);
    await cancelSale(world.a.as.MANAGER, { saleId: gone.id, note: "Rung up by mistake" });
    expect(await state()).toEqual(["10.000", "0.000", "50.000"]);

    // Sold again; the customer brings 5 back: 10 − 13 + 5 = 2.
    const sale = await sellOffline(13);
    expect(await state()).toEqual(["0.000", "3.000", "50.000"]);
    const line = await getDb().saleLine.findFirstOrThrow({ where: { saleId: sale.id } });
    await postReturn(world.a.as.MANAGER, { requestId: randomUUID(), saleId: sale.id, reason: "Not needed", lines: [{ saleLineId: line.id, quantity: "5", disposition: "SHELF" }], refundMethodId: world.a.cashMethodId, terminalId: world.a.terminalId });
    expect(await state()).toEqual(["2.000", "0.000", "50.000"]);
    expect(await listStockOwed(world.a.as.MANAGER)).toEqual({ rows: [], salesCount: 0 });
  });
});
