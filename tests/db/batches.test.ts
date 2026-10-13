import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMonths, shopToday } from "@/lib/format";
import { recordAdjustment } from "@/server/business/adjustments";
import { createProduct, getProduct } from "@/server/business/catalog";
import { runSetupImport } from "@/server/business/imports";
import { postReturn } from "@/server/business/returns";
import { postSale } from "@/server/business/sales";
import { getProductBatches, getProductStockHistory, receiveGoods } from "@/server/business/stock";
import { openTill } from "@/server/business/till";
import { transferStock } from "@/server/business/transfers";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { makeWorkbook } from "../support/workbook";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, type World } from "../support/world";

/**
 * Batches (C73, step 1 — C75) and a product's stock history (C74).
 *
 * The herbicide has batch numbers and expiry dates. What is left of each batch is worked out
 * on the rule "what goes first was sold first": earliest expiry, then first in. After every
 * test, `expectBalancesMatchMovements` also checks that the batches of each such product add
 * up to its stock in every place.
 */

let world: World;
let herbicide: { id: string; unitId: string };
const today = shopToday();
const soon = addMonths(today, 2);
const late = addMonths(today, 8);

beforeEach(async () => {
  world = await createWorld();
  const admin = world.a.as.ADMIN;
  const created = await createProduct(admin, { name: "Liquid Herbicide", code: "", barcode: "", baseUnitName: "litre", allowsFraction: false, taxable: true, tracksBatch: true, tracksExpiry: true, baseForSale: true, basePrice: "1000" });
  herbicide = { id: created.id, unitId: (await getProduct(admin, { productId: created.id })).product.units[0].id };
  await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "0" });
});

afterEach(async () => {
  await expectBalancesMatchMovements();
  await expectCustomerBalancesMatchEntries();
});

const receive = (quantity: string, batchNumber: string, expiryDate: string, locationId = world.a.storeroomId) =>
  receiveGoods(world.a.as.ADMIN, { requestId: randomUUID(), supplierId: world.a.supplierId, locationId, lines: [{ productId: herbicide.id, unitId: herbicide.unitId, quantity, unitCost: "600", batchNumber, expiryDate }] });
/** Batch number, what the Shelf holds of it, what the Storeroom holds, in the order they should go. */
const batches = async () =>
  (await getProductBatches(world.a.as.STOREKEEPER, { productId: herbicide.id })).batches.map((batch) => [
    batch.batchNumber,
    batch.byLocation[world.a.shelfId] ?? "0.000",
    batch.byLocation[world.a.storeroomId] ?? "0.000",
  ]);

describe("the batches of a product", () => {
  it("are what came in, less what has gone from the batch that goes first; the first to go stand on the Shelf", async () => {
    // The later-expiring batch arrives first: the order is by expiry date, not by arrival.
    await receive("30", "B-LATE", late);
    await receive("20", "B-SOON", soon);
    const all = await getProductBatches(world.a.as.CASHIER, { productId: herbicide.id });
    expect(all).toMatchObject({ tracked: true, baseUnitName: "litre" });
    expect(all.batches.map((batch) => [batch.batchNumber, batch.expiryDate, batch.receivedOn, batch.total, batch.soon, batch.expired])).toEqual([
      ["B-SOON", soon, today, "20.000", true, false],
      ["B-LATE", late, today, "30.000", false, false],
    ]);
    expect(await batches()).toEqual([["B-SOON", "0.000", "20.000"], ["B-LATE", "0.000", "30.000"]]);

    // 25 go to the Shelf: all 20 of the batch that goes first, and 5 of the next.
    await transferStock(world.a.as.STOREKEEPER, { requestId: randomUUID(), fromLocationId: world.a.storeroomId, toLocationId: world.a.shelfId, lines: [{ productId: herbicide.id, unitId: herbicide.unitId, quantity: "25" }] });
    expect(await batches()).toEqual([["B-SOON", "20.000", "0.000"], ["B-LATE", "5.000", "25.000"]]);

    // 22 are sold: the whole first batch and 2 of the second.
    const sale = await postSale(world.a.as.CASHIER, {
      requestId: randomUUID(),
      terminalId: world.a.terminalId,
      expectedTotal: "22000.00",
      payments: [{ methodId: world.a.cashMethodId, amount: "22000.00" }],
      lines: [{ productId: herbicide.id, unitId: herbicide.unitId, quantity: "22", unitPrice: "1000.00" }],
    });
    expect(await batches()).toEqual([["B-LATE", "3.000", "25.000"]]);

    // 4 come back to the Shelf: 2 of them make up the second batch again, 2 the first.
    const line = await getDb().saleLine.findFirstOrThrow({ where: { saleId: sale.id } });
    await postReturn(world.a.as.MANAGER, { requestId: randomUUID(), saleId: sale.id, reason: "Not needed", lines: [{ saleLineId: line.id, quantity: "4", disposition: "SHELF" }], refundMethodId: world.a.cashMethodId, terminalId: world.a.terminalId });
    expect(await batches()).toEqual([["B-SOON", "2.000", "0.000"], ["B-LATE", "5.000", "25.000"]]);

    // More found in a count than ever came in by delivery belongs to no batch on record, and goes last.
    await recordAdjustment(world.a.as.MANAGER, { requestId: randomUUID(), locationId: world.a.storeroomId, note: "", lines: [{ productId: herbicide.id, unitId: herbicide.unitId, direction: "add", quantity: "25", reason: "FOUND" }] });
    expect(await batches()).toEqual([["B-SOON", "7.000", "13.000"], ["B-LATE", "0.000", "30.000"], [null, "0.000", "7.000"]]);
  });

  it("join deliveries of the same batch number and expiry date, whatever the capitals; a product without either has none", async () => {
    await receive("10", "LH-7", soon);
    await receive("5", " lh-7 ", soon);
    await receive("5", "LH-7", late);
    const data = await getProductBatches(world.a.as.ADMIN, { productId: herbicide.id });
    expect(data.batches.map((batch) => [batch.batchNumber, batch.expiryDate, batch.total])).toEqual([["LH-7", soon, "15.000"], ["LH-7", late, "5.000"]]);
    expect(await getDb().stockBatch.count({ where: { productId: herbicide.id } })).toBe(2);

    // The sample product has neither a batch number nor an expiry date.
    await receiveGoods(world.a.as.ADMIN, { requestId: randomUUID(), supplierId: world.a.supplierId, locationId: world.a.shelfId, lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "10", unitCost: "50" }] });
    expect(await getProductBatches(world.a.as.ADMIN, { productId: world.a.product.id })).toMatchObject({ tracked: false, batches: [] });
    expect(await getDb().stockBatchBalance.count({ where: { productId: world.a.product.id } })).toBe(0);
  });

  it("are worked out on first sight for stock that was there before batches were counted; and only a business's own product is shown", async () => {
    await receive("12", "OLD-1", soon);
    // As it was before this feature: stock, and no batches.
    await getDb().stockBatchBalance.deleteMany({ where: { productId: herbicide.id } });
    expect(await batches()).toEqual([["OLD-1", "0.000", "12.000"]]);
    expect((await getDb().stockBatchBalance.findMany({ where: { productId: herbicide.id } })).map((row) => row.quantity.toFixed(3))).toEqual(["12.000"]);

    await expect(getProductBatches(world.b.as.ADMIN, { productId: herbicide.id })).rejects.toBeInstanceOf(NotFoundError);
    // The database keeps what is left of a batch from going below nothing.
    await expect(getDb().stockBatchBalance.updateMany({ where: { productId: herbicide.id }, data: { quantity: "-1" } })).rejects.toThrow();
  });
});

describe("a product's stock history", () => {
  it("lists every movement in order with what was left afterwards, starting from what was held before", async () => {
    // 40 pieces were on the Shelf five days ago, brought in from the shop's records.
    const fiveDaysAgo = shopToday(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
    await runSetupImport(world.a.as.ADMIN, { fileName: "start.xlsx", startingDay: fiveDaysAgo }, await makeWorkbook({
      products: [{ code: "RAKE-1", name: "Garden Rake", unit: "piece", contains: "1", price: "1500" }],
      stock: [{ code: "RAKE-1", unit: "piece", quantity: "40", cost: "900" }],
    }));
    const rake = await getDb().product.findFirstOrThrow({ where: { businessId: world.a.id, code: "RAKE-1" }, include: { units: true } });
    const piece = rake.units[0].id;
    const line = (quantity: string) => [{ productId: rake.id, unitId: piece, quantity }];

    // Today: 25 delivered to the Storeroom, 10 moved to the Shelf, 3 sold, 2 written off in the Storeroom.
    const delivery = await receiveGoods(world.a.as.STOREKEEPER, { requestId: randomUUID(), supplierId: world.a.supplierId, locationId: world.a.storeroomId, lines: [{ ...line("25")[0], unitCost: "900" }] });
    const transfer = await transferStock(world.a.as.STOREKEEPER, { requestId: randomUUID(), fromLocationId: world.a.storeroomId, toLocationId: world.a.shelfId, lines: line("10") });
    const sale = await postSale(world.a.as.CASHIER, { requestId: randomUUID(), terminalId: world.a.terminalId, expectedTotal: "4500.00", payments: [{ methodId: world.a.cashMethodId, amount: "4500.00" }], lines: [{ ...line("3")[0], unitPrice: "1500.00" }] });
    const adjustment = await recordAdjustment(world.a.as.MANAGER, { requestId: randomUUID(), locationId: world.a.storeroomId, note: "", lines: [{ ...line("2")[0], direction: "remove", reason: "DAMAGED" }] });

    const history = await getProductStockHistory(world.a.as.ACCOUNTANT, { productId: rake.id, from: today, to: today });
    expect(history.product).toMatchObject({ name: "Garden Rake", baseUnitName: "piece" });
    expect(history.opening).toEqual({ byLocation: { [world.a.shelfId]: "40.000", [world.a.storeroomId]: "0.000" }, total: "40.000" });
    expect(history.rows.map((row) => [row.type, row.locationName, row.quantity, row.leftThere, row.leftInAll, row.documentNumber, row.userName])).toEqual([
      ["RECEIPT", "Storeroom", "25.000", "25.000", "65.000", "GR-000002", "Test a.storekeeper"],
      ["TRANSFER_OUT", "Storeroom", "-10.000", "15.000", "55.000", "TR-000001", "Test a.storekeeper"],
      ["TRANSFER_IN", "Shelf", "10.000", "50.000", "65.000", "TR-000001", "Test a.storekeeper"],
      ["SALE", "Shelf", "-3.000", "47.000", "62.000", sale.receiptNumber, "Test a.cashier"],
      ["ADJUSTMENT", "Storeroom", "-2.000", "13.000", "60.000", "AD-000001", "Test a.manager"],
    ]);
    expect(history.rows.map((row) => row.documentHref)).toEqual([`/stock/receipts/${delivery.id}`, `/stock/transfers/${transfer.id}`, `/stock/transfers/${transfer.id}`, `/sales/${sale.id}`, `/stock/adjustments/${adjustment.id}`]);
    expect(history).toMatchObject({ cameIn: "35.000", wentOut: "15.000", more: 0, closing: { byLocation: { [world.a.shelfId]: "47.000", [world.a.storeroomId]: "13.000" }, total: "60.000" } });

    // The days before: only the opening stock, from nothing to 40.
    const yesterday = shopToday(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const before = await getProductStockHistory(world.a.as.STOREKEEPER, { productId: rake.id, from: fiveDaysAgo, to: yesterday });
    expect(before.opening.total).toBe("0.000");
    expect(before.rows.map((row) => [row.type, row.quantity, row.leftInAll, row.documentHref !== null])).toEqual([["OPENING_BALANCE", "40.000", "40.000", true]]);
    expect(before.closing.total).toBe("40.000");
    // A day when nothing moved shows what was held, unchanged.
    expect(await getProductStockHistory(world.a.as.MANAGER, { productId: rake.id, from: yesterday, to: yesterday })).toMatchObject({ rows: [], opening: { total: "40.000" }, closing: { total: "40.000" }, cameIn: "0.000", wentOut: "0.000" });
    // With no dates: this month so far.
    expect((await getProductStockHistory(world.a.as.ADMIN, { productId: rake.id })).period).toEqual({ from: `${today.slice(0, 8)}01`, to: today });

    await expect(getProductStockHistory(world.a.as.CASHIER, { productId: rake.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getProductStockHistory(world.b.as.ADMIN, { productId: rake.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProductStockHistory(world.a.as.ADMIN, { productId: rake.id, from: today, to: yesterday })).rejects.toBeInstanceOf(ValidationError);
  });
});
