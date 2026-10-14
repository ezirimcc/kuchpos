import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMonths, shopToday } from "@/lib/format";
import { getAdjustment, recordAdjustment } from "@/server/business/adjustments";
import { createProduct, getProduct } from "@/server/business/catalog";
import { runSetupImport } from "@/server/business/imports";
import { postReturn } from "@/server/business/returns";
import { cancelSale, postSale } from "@/server/business/sales";
import { correctReceipt, getCorrectionOptions } from "@/server/business/receipt-corrections";
import { getProductBatches, getProductStockHistory, receiveGoods } from "@/server/business/stock";
import { openTill } from "@/server/business/till";
import { getTransfer, transferStock } from "@/server/business/transfers";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { makeWorkbook } from "../support/workbook";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, type World } from "../support/world";

/**
 * Batches, recorded in the Storeroom only (C73 as changed by C76) — and a product's stock
 * history (C74).
 *
 * The herbicide has batch numbers and expiry dates. The Storeroom keeps exact figures per batch;
 * every movement into or out of it names its batch. The Shelf keeps only a quantity. After every
 * test, `expectBalancesMatchMovements` also checks that the Storeroom's batches add up to its
 * stock and that no other place has batch figures.
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
/** The Storeroom's batches, in the order they should go: [batch number, expiry, what is left]. */
const batches = async () => (await getProductBatches(world.a.as.STOREKEEPER, { productId: herbicide.id })).batches.map((batch) => [batch.batchNumber, batch.expiryDate, batch.quantity]);
const batchId = async (batchNumber: string) => (await getDb().stockBatch.findFirstOrThrow({ where: { productId: herbicide.id, batchNumber } })).id;
const move = (fromLocationId: string, toLocationId: string, quantity: string, batch: Record<string, string>, as = world.a.as.STOREKEEPER) =>
  transferStock(as, { requestId: randomUUID(), fromLocationId, toLocationId, lines: [{ productId: herbicide.id, unitId: herbicide.unitId, quantity, ...batch }] });
const fieldErrorsOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).fieldErrors;
};
const sell = (quantity: string, fromStoreroom: boolean, as = world.a.as.MANAGER) =>
  postSale(as, {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    expectedTotal: `${quantity}000.00`,
    payments: [{ methodId: world.a.cashMethodId, amount: `${quantity}000.00` }],
    lines: [{ productId: herbicide.id, unitId: herbicide.unitId, quantity, unitPrice: "1000.00", fromStoreroom }],
  });

describe("batches in the Storeroom", () => {
  it("are what came in, in the order they should go (earliest expiry first); deliveries to the Shelf have no batch figures", async () => {
    // The later-expiring batch arrives first: the order is by expiry date, not by arrival.
    await receive("30", "B-LATE", late);
    await receive("20", "B-SOON", soon);
    await receive("7", "B-SHELF", soon, world.a.shelfId);
    const all = await getProductBatches(world.a.as.CASHIER, { productId: herbicide.id });
    expect(all).toMatchObject({ tracked: true, baseUnitName: "litre", storeroom: { id: world.a.storeroomId }, onShelf: "7.000" });
    expect(await batches()).toEqual([["B-SOON", soon, "20.000"], ["B-LATE", late, "30.000"]]);
    expect(all.batches[0]).toMatchObject({ soon: true, expired: false });
    expect(await getDb().stockBatchBalance.count({ where: { productId: herbicide.id, locationId: world.a.shelfId } })).toBe(0);
    // Every Storeroom movement names its batch; the Shelf's do not.
    const movements = await getDb().stockMovement.findMany({ where: { productId: herbicide.id }, select: { locationId: true, batchId: true } });
    expect(movements.filter((row) => row.locationId === world.a.storeroomId).every((row) => row.batchId !== null)).toBe(true);
    expect(movements.filter((row) => row.locationId === world.a.shelfId).every((row) => row.batchId === null)).toBe(true);
    // …and the product's stock history says which batch.
    const history = await getProductStockHistory(world.a.as.ADMIN, { productId: herbicide.id, from: today, to: today });
    expect(history.rows.map((row) => [row.locationName, row.batch?.split(" (")[0] ?? null])).toEqual([["Storeroom", "B-LATE"], ["Storeroom", "B-SOON"], ["Shelf", null]]);
  });

  it("join deliveries of the same batch number and expiry date, whatever the capitals; a product without either has none", async () => {
    await receive("10", "LH-7", soon);
    await receive("5", " lh-7 ", soon);
    await receive("5", "LH-7", late);
    expect(await batches()).toEqual([["LH-7", soon, "15.000"], ["LH-7", late, "5.000"]]);
    expect(await getDb().stockBatch.count({ where: { productId: herbicide.id } })).toBe(2);

    // The sample product has neither a batch number nor an expiry date.
    await receiveGoods(world.a.as.ADMIN, { requestId: randomUUID(), supplierId: world.a.supplierId, locationId: world.a.storeroomId, lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "10", unitCost: "50" }] });
    expect(await getProductBatches(world.a.as.ADMIN, { productId: world.a.product.id })).toMatchObject({ tracked: false, batches: [] });
    expect(await getDb().stockBatchBalance.count({ where: { productId: world.a.product.id } })).toBe(0);
  });

  it("move out with a transfer that names the batch; a later batch may still be moved, and the transfer notes that an earlier one was passed over", async () => {
    await receive("30", "B-LATE", late);
    await receive("20", "B-SOON", soon);

    // No batch named: refused, keyed to the line.
    expect(Object.keys(await fieldErrorsOf(move(world.a.storeroomId, world.a.shelfId, "5", {})))).toEqual(["lines.0.batchId"]);

    const right = await move(world.a.storeroomId, world.a.shelfId, "5", { batchId: await batchId("B-SOON") });
    const passedOver = await move(world.a.storeroomId, world.a.shelfId, "4", { batchId: await batchId("B-LATE") });
    expect(await batches()).toEqual([["B-SOON", soon, "15.000"], ["B-LATE", late, "26.000"]]);
    const first = await getTransfer(world.a.as.STOREKEEPER, { transferId: right.id });
    const second = await getTransfer(world.a.as.STOREKEEPER, { transferId: passedOver.id });
    expect(first.lines[0]).toMatchObject({ batchNumber: "B-SOON", expiryDate: soon, hasBatch: true, earlierBatchWaiting: false });
    expect(second.lines[0]).toMatchObject({ batchNumber: "B-LATE", expiryDate: late, earlierBatchWaiting: true });

    // More than the batch holds is refused, even though the Storeroom holds enough in all.
    expect((await fieldErrorsOf(move(world.a.storeroomId, world.a.shelfId, "16", { batchId: await batchId("B-SOON") })))["lines.0.quantity"]).toMatch(/Only 15 litre of batch B-SOON/);
    expect(await batches()).toEqual([["B-SOON", soon, "15.000"], ["B-LATE", late, "26.000"]]);

  });

  it("move back in with a transfer naming a batch on record, or a new batch number and expiry date", async () => {
    await receive("10", "B-SOON", soon, world.a.shelfId);
    // Goods going into the Storeroom name their batch too.
    expect(Object.keys(await fieldErrorsOf(move(world.a.shelfId, world.a.storeroomId, "2", {})))).toContain("lines.0.batchId");
    expect(Object.keys(await fieldErrorsOf(move(world.a.shelfId, world.a.storeroomId, "2", { batchNumber: "NEW-1" })))).toContain("lines.0.expiryDate");

    await move(world.a.shelfId, world.a.storeroomId, "3", { batchId: await batchId("B-SOON") });
    await move(world.a.shelfId, world.a.storeroomId, "2", { batchNumber: "NEW-1", expiryDate: late });
    expect(await batches()).toEqual([["B-SOON", soon, "3.000"], ["NEW-1", late, "2.000"]]);
    // The Shelf's stock is just a quantity.
    expect((await getProductBatches(world.a.as.ADMIN, { productId: herbicide.id })).onShelf).toBe("5.000");
  });

  it("are taken from the batch that should go first by a sale straight from the Storeroom, and come back to it when the sale is cancelled", async () => {
    await receive("30", "B-LATE", late);
    await receive("20", "B-SOON", soon);
    const sale = await sell("25", true);
    expect(await batches()).toEqual([["B-LATE", late, "25.000"]]);
    const parts = await getDb().stockMovement.findMany({ where: { documentId: sale.id, type: "SALE" }, include: { batch: true }, orderBy: { quantityDelta: "asc" } });
    expect(parts.map((row) => [row.batch?.batchNumber, row.quantityDelta.toFixed(3)])).toEqual([["B-SOON", "-20.000"], ["B-LATE", "-5.000"]]);

    await cancelSale(world.a.as.MANAGER, { saleId: sale.id, note: "Rang up the wrong product" });
    expect(await batches()).toEqual([["B-SOON", soon, "20.000"], ["B-LATE", late, "30.000"]]);
  });

  it("take goods returned into the Storeroom back into the batch they were sold from; goods sold from the Shelf cannot be returned into it", async () => {
    await receive("10", "B-SOON", soon);
    await receive("5", "B-SHELF", soon, world.a.shelfId);
    const fromStoreroom = await sell("4", true);
    const fromShelf = await sell("2", false);
    const line = async (saleId: string) => (await getDb().saleLine.findFirstOrThrow({ where: { saleId } })).id;
    const giveBack = async (saleId: string, disposition: "SHELF" | "STOREROOM") =>
      postReturn(world.a.as.MANAGER, {
        requestId: randomUUID(),
        saleId,
        reason: "Wrong product",
        lines: [{ saleLineId: await line(saleId), quantity: "1", disposition }],
        refundMethodId: world.a.cashMethodId,
        terminalId: world.a.terminalId,
      });

    await giveBack(fromStoreroom.id, "STOREROOM");
    expect(await batches()).toEqual([["B-SOON", soon, "7.000"]]);
    expect(Object.keys(await fieldErrorsOf(giveBack(fromShelf.id, "STOREROOM")))).toEqual(["lines.0.disposition"]);
    // Onto the Shelf it is fine.
    await giveBack(fromShelf.id, "SHELF");
  });

  it("change by an adjustment in the Storeroom that names its batch; a line with no batch named takes from the batch that should go first", async () => {
    await receive("30", "B-LATE", late);
    await receive("20", "B-SOON", soon);
    const line = (quantity: string, direction: "remove" | "add", batch: Record<string, string>) => ({ productId: herbicide.id, unitId: herbicide.unitId, quantity, direction, reason: "DAMAGED", ...batch });
    const adjust = (lines: ReturnType<typeof line>[]) => recordAdjustment(world.a.as.MANAGER, { requestId: randomUUID(), locationId: world.a.storeroomId, note: "", lines });

    expect(Object.keys(await fieldErrorsOf(adjust([line("1", "remove", {})])))).toEqual(["lines.0.batchId"]);
    const saved = await adjust([line("3", "remove", { batchId: await batchId("B-LATE") }), line("2", "add", { batchNumber: "FOUND-1", expiryDate: late })]);
    expect(await batches()).toEqual([["B-SOON", soon, "20.000"], ["B-LATE", late, "27.000"], ["FOUND-1", late, "2.000"]]);
    expect((await getAdjustment(world.a.as.MANAGER, { adjustmentId: saved.id })).lines.map((entry) => entry.batch)).toEqual([expect.stringMatching(/^B-LATE \(expires /), expect.stringMatching(/^FOUND-1 \(expires /)]);
    // More than the batch holds: refused, nothing changes.
    await expect(adjust([line("21", "remove", { batchId: await batchId("B-SOON") })])).rejects.toBeInstanceOf(ValidationError);
    expect(await batches()).toEqual([["B-SOON", soon, "20.000"], ["B-LATE", late, "27.000"], ["FOUND-1", late, "2.000"]]);
    // On the Shelf no batch is named.
    await recordAdjustment(world.a.as.MANAGER, { requestId: randomUUID(), locationId: world.a.shelfId, note: "", lines: [{ productId: herbicide.id, unitId: herbicide.unitId, quantity: "1", direction: "add", reason: "FOUND" }] });
  });

  it("follow a corrected delivery: a wrong batch number or quantity is put right, and a delivery moved to the Shelf takes its batch with it", async () => {
    const saved = await receive("10", "B-TYPO", soon);
    await receive("5", "B-OTHER", late);
    const draft = async () => {
      const { receipt } = await getCorrectionOptions(world.a.as.ADMIN, { receiptId: saved.id });
      return {
        receiptId: saved.id,
        requestId: randomUUID(),
        expectedVersion: receipt.version,
        reason: "Typed wrongly",
        supplierId: receipt.supplierId,
        locationId: receipt.locationId,
        receivedOn: receipt.receivedOn,
        invoiceNumber: receipt.invoiceNumber,
        note: receipt.note,
        lines: receipt.lines.map((line) => ({ lineNumber: line.lineNumber, productId: line.productId, unitId: line.unitId, quantity: line.quantity, unitCost: line.unitCost, batchNumber: line.batchNumber, expiryDate: line.expiryDate })),
      };
    };
    // Only the batch number was wrong: the stock stays, the batch changes.
    const first = await draft();
    first.lines[0].batchNumber = "B-1";
    await correctReceipt(world.a.as.ADMIN, first);
    expect(await batches()).toEqual([["B-1", soon, "10.000"], ["B-OTHER", late, "5.000"]]);
    // Fewer arrived.
    const second = await draft();
    second.lines[0].quantity = "7";
    await correctReceipt(world.a.as.ADMIN, second);
    expect(await batches()).toEqual([["B-1", soon, "7.000"], ["B-OTHER", late, "5.000"]]);
    // It went onto the Shelf after all.
    const third = await draft();
    third.locationId = world.a.shelfId;
    await correctReceipt(world.a.as.ADMIN, third);
    expect(await batches()).toEqual([["B-OTHER", late, "5.000"]]);
  });

  it("are split once for Storeroom stock from before batches were recorded: what came in first went first; and only a business's own product is shown", async () => {
    await receive("12", "OLD-1", soon);
    await receive("8", "OLD-2", late);
    await sell("8", true);
    // As it was before batches were recorded: stock, and no batch figures.
    await getDb().stockBatchBalance.deleteMany({ where: { productId: herbicide.id } });
    // 20 came in, 8 were sold, 12 are left: the 12 are given to the batches that go last — all 8 of OLD-2 and 4 of OLD-1.
    expect(await batches()).toEqual([["OLD-1", soon, "4.000"], ["OLD-2", late, "8.000"]]);

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
