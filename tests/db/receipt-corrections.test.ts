import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMonths, shopToday } from "@/lib/format";
import { addUnit, createProduct, retireUnit, setProductActive } from "@/server/business/catalog";
import { correctReceipt, getCorrectionOptions, getReceiptHistory } from "@/server/business/receipt-corrections";
import { getReceipt, listExpiringSoon, listReceipts, receiveGoods } from "@/server/business/stock";
import { setSupplierActive } from "@/server/business/suppliers";
import type { AppContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, type World } from "../support/world";

/**
 * Correcting a saved delivery: the original stays on record, stock is corrected with new
 * movements only, and nothing impossible can be saved.
 */

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

// The golden rule, checked after every single test in this file.
afterEach(async () => {
  await expectBalancesMatchMovements();
});

async function refusal(attempt: Promise<unknown>): Promise<ValidationError> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("Expected the call to be refused.");
}

type Line = { productId: string; unitId: string; quantity: string; unitCost: string; batchNumber?: string; expiryDate?: string };

async function deliver(lines: Line[], extra: Record<string, unknown> = {}): Promise<string> {
  const saved = await receiveGoods(world.a.as.ADMIN, {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.storeroomId,
    lines,
    ...extra,
  });
  return saved.id;
}

/** Two packs of ten at ₦700 a pack, into the Storeroom: 20 singles costing ₦1,400. */
const twoPacks = () => deliver([{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "2", unitCost: "700" }]);

type CorrectionLine = Line & { lineNumber: number | null };
type Correction = {
  receiptId: string;
  requestId: string;
  expectedVersion: number;
  reason: string;
  supplierId: string;
  locationId: string;
  receivedOn: string;
  invoiceNumber: string;
  note: string;
  lines: CorrectionLine[];
};

/** The delivery exactly as it stands, ready for a test to change something in it. */
async function draft(receiptId: string, reason = "Counted the goods again"): Promise<Correction> {
  const { receipt } = await getCorrectionOptions(world.a.as.ADMIN, { receiptId });
  return {
    receiptId,
    requestId: randomUUID(),
    expectedVersion: receipt.version,
    reason,
    supplierId: receipt.supplierId,
    locationId: receipt.locationId,
    receivedOn: receipt.receivedOn,
    invoiceNumber: receipt.invoiceNumber,
    note: receipt.note,
    lines: receipt.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productId: line.productId,
      unitId: line.unitId,
      quantity: line.quantity,
      unitCost: line.unitCost,
      batchNumber: line.batchNumber,
      expiryDate: line.expiryDate,
    })),
  };
}

async function quantityAt(productId: string, locationId: string): Promise<string> {
  const balance = await getDb().stockBalance.findUnique({ where: { productId_locationId: { productId, locationId } } });
  return balance ? balance.quantity.toFixed(3) : "0.000";
}

async function averageCost(productId: string): Promise<string> {
  return (await getDb().product.findUniqueOrThrow({ where: { id: productId } })).averageCost.toFixed(4);
}

async function movementsOf(productId: string) {
  const rows = await getDb().stockMovement.findMany({ where: { productId }, orderBy: [{ createdAt: "asc" }, { type: "asc" }] });
  return rows.map((row) => ({ type: row.type, locationId: row.locationId, delta: row.quantityDelta.toFixed(3) }));
}

/** Stands in for goods that have since been sold or moved (those features come later). */
async function goodsLeave(productId: string, locationId: string, quantity: string) {
  const db = getDb();
  await db.$transaction([
    db.stockBalance.update({ where: { productId_locationId: { productId, locationId } }, data: { quantity: { decrement: quantity } } }),
    db.stockMovement.create({
      data: {
        businessId: world.a.id,
        productId,
        locationId,
        type: "RECEIPT_CORRECTION",
        quantityDelta: `-${quantity}`,
        unitName: "single",
        unitFactor: "1",
        unitQuantity: `-${quantity}`,
        documentType: "test",
        documentId: randomUUID(),
        documentNumber: "TEST",
        userName: "Test",
      },
    }),
  ]);
}

/** A second whole-unit product in business A. */
async function secondProduct() {
  const { id } = await createProduct(world.a.as.ADMIN, {
    name: "Hand Sprayer",
    code: "",
    barcode: "",
    baseUnitName: "piece",
    allowsFraction: false,
    taxable: true,
    tracksBatch: false,
    tracksExpiry: false,
    baseForSale: true,
    basePrice: "5000",
  });
  const piece = await getDb().productUnit.findFirstOrThrow({ where: { productId: id, isBase: true } });
  return { productId: id, pieceId: piece.id };
}

/** Everything saved about deliveries and stock, for "nothing changed" checks. */
async function everything() {
  const db = getDb();
  return JSON.stringify({
    receipts: await db.goodsReceipt.findMany({ orderBy: { id: "asc" } }),
    lines: await db.goodsReceiptLine.findMany({ orderBy: [{ receiptId: "asc" }, { lineNumber: "asc" }] }),
    versions: await db.goodsReceiptVersion.findMany({ orderBy: { id: "asc" } }),
    versionLines: await db.goodsReceiptVersionLine.count(),
    changes: await db.goodsReceiptChange.count(),
    movements: await db.stockMovement.findMany({ orderBy: { id: "asc" } }),
    balances: await db.stockBalance.findMany({ orderBy: { id: "asc" } }),
    averages: await db.product.findMany({ orderBy: { id: "asc" }, select: { id: true, averageCost: true } }),
    activity: await db.activityLog.count(),
  });
}

describe("correcting a quantity", () => {
  it("raises stock with a NEW movement when more arrived than was entered, leaving the first movement as it was", async () => {
    const id = await twoPacks();
    const [first] = await getDb().stockMovement.findMany({ where: { documentId: id } });

    const input = await draft(id);
    input.lines[0].quantity = "3";
    const result = await correctReceipt(world.a.as.MANAGER, input);

    expect(result).toMatchObject({ id, number: 1, version: 2, alreadySaved: false });
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("30.000");
    expect(await movementsOf(world.a.product.id)).toEqual([
      { type: "RECEIPT", locationId: world.a.storeroomId, delta: "20.000" },
      { type: "RECEIPT_CORRECTION", locationId: world.a.storeroomId, delta: "10.000" },
    ]);
    // The first movement is byte-for-byte what it was.
    expect(await getDb().stockMovement.findUniqueOrThrow({ where: { id: first.id } })).toEqual(first);

    const receipt = await getReceipt(world.a.as.ADMIN, { receiptId: id });
    expect(receipt.version).toBe(2);
    expect(receipt.lines).toHaveLength(1);
    expect(receipt.lines[0]).toMatchObject({ lineNumber: 1, quantity: "3.000", baseQuantity: "30.000", lineCost: "2100.00" });
    expect(receipt.totalCost).toBe("2100.00");
  });

  it("lowers stock with a negative movement when fewer arrived than was entered", async () => {
    const id = await deliver([{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "3", unitCost: "700" }]);
    const input = await draft(id);
    input.lines[0].quantity = "1";
    await correctReceipt(world.a.as.ADMIN, input);

    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("10.000");
    expect(await movementsOf(world.a.product.id)).toEqual([
      { type: "RECEIPT", locationId: world.a.storeroomId, delta: "30.000" },
      { type: "RECEIPT_CORRECTION", locationId: world.a.storeroomId, delta: "-20.000" },
    ]);
    // The unit cost was right all along, so the average cost does not move.
    expect(await averageCost(world.a.product.id)).toBe("70.0000");
  });

  it("works out the difference in base units when the unit was wrong (2 packs were really 2 singles)", async () => {
    const id = await twoPacks();
    const input = await draft(id);
    input.lines[0].unitId = world.a.product.baseUnitId;
    input.lines[0].unitCost = "70";
    await correctReceipt(world.a.as.ADMIN, input);

    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("2.000");
    const receipt = await getReceipt(world.a.as.ADMIN, { receiptId: id });
    expect(receipt.lines[0]).toMatchObject({ unitName: "single", unitFactor: "1.000", quantity: "2.000", baseQuantity: "2.000", lineCost: "140.00" });
    const [, corrected] = await getReceiptHistory(world.a.as.ADMIN, { receiptId: id });
    expect(corrected.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lineNumber: 1, label: "Arrived", oldValue: "2 pack", newValue: "2 single" }),
        expect.objectContaining({ lineNumber: 1, label: "Cost each", oldValue: "₦700.00 per pack", newValue: "₦70.00 per single" }),
      ]),
    );
  });
});

describe("correcting other fields", () => {
  it("changes supplier, date, invoice number and note without touching stock", async () => {
    const id = await twoPacks();
    const other = await getDb().supplier.create({ data: { businessId: world.a.id, name: "Other Agro Ltd" } });
    const yesterday = addMonths(shopToday(), -1);

    const input = await draft(id, "Wrong supplier and invoice were typed");
    input.supplierId = other.id;
    input.receivedOn = yesterday;
    input.invoiceNumber = "INV-77";
    input.note = "Checked against the waybill";
    await correctReceipt(world.a.as.ADMIN, input);

    expect(await getDb().stockMovement.count()).toBe(1);
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("20.000");
    const receipt = await getReceipt(world.a.as.ADMIN, { receiptId: id });
    expect(receipt).toMatchObject({ supplierName: "Other Agro Ltd", receivedOn: yesterday, invoiceNumber: "INV-77", note: "Checked against the waybill", version: 2 });

    const [, corrected] = await getReceiptHistory(world.a.as.ADMIN, { receiptId: id });
    expect(corrected.stockEffects).toEqual([]);
    expect(corrected.changes.map((change) => change.label)).toEqual(["Supplier", "Date received", "Supplier's invoice", "Note"]);
    expect(corrected.changes[0]).toMatchObject({ oldValue: "A Supplies Ltd", newValue: "Other Agro Ltd" });
    expect(corrected.changes[2]).toMatchObject({ oldValue: null, newValue: "INV-77" });
  });

  it("moves the goods when they went into the other location: out of one, into the other", async () => {
    const id = await twoPacks();
    const input = await draft(id);
    input.locationId = world.a.shelfId;
    await correctReceipt(world.a.as.ADMIN, input);

    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("0.000");
    expect(await quantityAt(world.a.product.id, world.a.shelfId)).toBe("20.000");
    const moved = (await movementsOf(world.a.product.id)).filter((movement) => movement.type === "RECEIPT_CORRECTION");
    expect(moved).toHaveLength(2);
    expect(moved).toEqual(
      expect.arrayContaining([
        { type: "RECEIPT_CORRECTION", locationId: world.a.storeroomId, delta: "-20.000" },
        { type: "RECEIPT_CORRECTION", locationId: world.a.shelfId, delta: "20.000" },
      ]),
    );
    expect(await averageCost(world.a.product.id)).toBe("70.0000");
  });

  it("corrects the cost: the total and the average cost follow, the stock does not move", async () => {
    const single = { productId: world.a.product.id, unitId: world.a.product.baseUnitId };
    await deliver([{ ...single, quantity: "100", unitCost: "50" }]);
    const id = await deliver([{ ...single, quantity: "100", unitCost: "70" }]);
    expect(await averageCost(world.a.product.id)).toBe("60.0000");

    const input = await draft(id, "Invoice shows 90 each, not 70");
    input.lines[0].unitCost = "90";
    await correctReceipt(world.a.as.ADMIN, input);

    // What the average would have been had 90 been entered the first time.
    expect(await averageCost(world.a.product.id)).toBe("70.0000");
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("200.000");
    expect(await getDb().stockMovement.count()).toBe(2);
    expect((await getReceipt(world.a.as.ADMIN, { receiptId: id })).totalCost).toBe("9000.00");
    const [, corrected] = await getReceiptHistory(world.a.as.ADMIN, { receiptId: id });
    expect(corrected.changes).toEqual([
      expect.objectContaining({ lineNumber: 1, label: "Cost each", oldValue: "₦70.00 per single", newValue: "₦90.00 per single" }),
      expect.objectContaining({ lineNumber: null, label: "Total cost", oldValue: "₦7,000.00", newValue: "₦9,000.00" }),
    ]);
  });

  it("re-prices only what is still in stock when most of the delivery has already gone", async () => {
    const id = await deliver([{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "100", unitCost: "50" }]);
    await goodsLeave(world.a.product.id, world.a.storeroomId, "90");

    const input = await draft(id);
    input.lines[0].unitCost = "60";
    await correctReceipt(world.a.as.ADMIN, input);
    expect(await averageCost(world.a.product.id)).toBe("60.0000");
  });

  it("corrects a batch number and an expiry date, and the expiring-soon list follows", async () => {
    const { id: productId } = await createProduct(world.a.as.ADMIN, {
      name: "Maize Seed",
      code: "",
      barcode: "",
      baseUnitName: "kg",
      allowsFraction: true,
      taxable: true,
      tracksBatch: true,
      tracksExpiry: true,
      baseForSale: true,
      basePrice: "900",
    });
    const kg = await getDb().productUnit.findFirstOrThrow({ where: { productId, isBase: true } });
    const farAway = addMonths(shopToday(), 24);
    const soon = addMonths(shopToday(), 1);
    const id = await deliver([{ productId, unitId: kg.id, quantity: "12.5", unitCost: "400", batchNumber: "B-1", expiryDate: farAway }]);
    expect((await listExpiringSoon(world.a.as.ADMIN)).rows).toHaveLength(0);

    const input = await draft(id, "Expiry date was misread");
    input.lines[0].batchNumber = "B-7";
    input.lines[0].expiryDate = soon;
    await correctReceipt(world.a.as.ADMIN, input);

    const [row] = (await listExpiringSoon(world.a.as.ADMIN)).rows;
    expect(row).toMatchObject({ batchNumber: "B-7", expiryDate: soon });
    expect(await getDb().stockMovement.count()).toBe(1);

    // Taking the batch number off a product that needs one is still refused.
    const bad = await draft(id);
    bad.lines[0].batchNumber = "";
    expect((await refusal(correctReceipt(world.a.as.ADMIN, bad))).fieldErrors["lines.0.batchNumber"]).toMatch(/needs a batch number/);
  });

  it("adds a forgotten line and removes a line that never arrived", async () => {
    const sprayer = await secondProduct();
    const id = await deliver([
      { productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "2", unitCost: "700" },
      { productId: sprayer.productId, unitId: sprayer.pieceId, quantity: "4", unitCost: "3000" },
    ]);

    const input = await draft(id, "Sprayers were not in the delivery; a carton of sachets was");
    input.lines = [input.lines[0], { lineNumber: null, productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "5", unitCost: "75" }];
    await correctReceipt(world.a.as.ADMIN, input);

    expect(await quantityAt(sprayer.productId, world.a.storeroomId)).toBe("0.000");
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("25.000");
    // The sprayers' average cost is left as it was: there are none left to value.
    expect(await averageCost(sprayer.productId)).toBe("3000.0000");
    // (20 × 70 + 5 × 75) ÷ 25
    expect(await averageCost(world.a.product.id)).toBe("71.0000");

    const receipt = await getReceipt(world.a.as.ADMIN, { receiptId: id });
    // The removed line's number (2) is not used again.
    expect(receipt.lines.map((line) => [line.lineNumber, line.productName, line.quantity])).toEqual([
      [1, "A Seed Sachet", "2.000"],
      [3, "A Seed Sachet", "5.000"],
    ]);
    expect(receipt.totalCost).toBe("1775.00");

    const [original, corrected] = await getReceiptHistory(world.a.as.ADMIN, { receiptId: id });
    expect(original.lines.map((line) => line.productName)).toEqual(["A Seed Sachet", "Hand Sprayer"]);
    expect(corrected.changes).toEqual([
      expect.objectContaining({ lineNumber: 2, label: "Line removed", oldValue: "4 piece of Hand Sprayer at ₦3,000.00 each", newValue: null }),
      expect.objectContaining({ lineNumber: 3, label: "Line added", oldValue: null, newValue: "5 single of A Seed Sachet at ₦75.00 each" }),
      expect.objectContaining({ label: "Total cost", oldValue: "₦13,400.00", newValue: "₦1,775.00" }),
    ]);
    expect(corrected.stockEffects).toEqual(
      expect.arrayContaining([
        { productName: "Hand Sprayer", locationName: "Storeroom", quantity: "-4.000", unitName: "piece" },
        { productName: "A Seed Sachet", locationName: "Storeroom", quantity: "5.000", unitName: "single" },
      ]),
    );
  });

  it("still allows a delivery to be corrected after its supplier, product and unit were taken out of use", async () => {
    const carton = await addUnit(world.a.as.ADMIN, { productId: world.a.product.id, name: "carton", factor: "100", forSale: true, forPurchase: true, price: "8500" });
    const id = await deliver([{ productId: world.a.product.id, unitId: carton.id, quantity: "1", unitCost: "6000" }]);
    await retireUnit(world.a.as.ADMIN, { unitId: carton.id });
    await setProductActive(world.a.as.ADMIN, { productId: world.a.product.id, active: false });
    await setSupplierActive(world.a.as.ADMIN, { supplierId: world.a.supplierId, active: false });

    const options = await getCorrectionOptions(world.a.as.ADMIN, { receiptId: id });
    expect(options.suppliers.map((supplier) => supplier.id)).toContain(world.a.supplierId);
    expect(options.products.find((product) => product.id === world.a.product.id)?.units.map((unit) => unit.id)).toContain(carton.id);

    const input = await draft(id);
    input.lines[0].quantity = "2";
    await correctReceipt(world.a.as.ADMIN, input);
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("200.000");

    // But a NEW line cannot use what is out of use.
    const more = await draft(id);
    more.lines.push({ lineNumber: null, productId: world.a.product.id, unitId: carton.id, quantity: "1", unitCost: "6000" });
    expect((await refusal(correctReceipt(world.a.as.ADMIN, more))).fieldErrors["lines.1.productId"]).toMatch(/out of use/);
  });
});

describe("the history of a delivery", () => {
  it("keeps the original as version 1 from the moment a delivery is saved", async () => {
    const id = await twoPacks();
    const history = await getReceiptHistory(world.a.as.STOREKEEPER, { receiptId: id });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ version: 1, reason: null, savedByName: "Test a.admin", supplierName: "A Supplies Ltd", locationName: "Storeroom", totalCost: "1400.00", changes: [], stockEffects: [] });
    expect(history[0].lines).toEqual([
      expect.objectContaining({ lineNumber: 1, productName: "A Seed Sachet", unitName: "pack", quantity: "2.000", baseQuantity: "20.000", unitCost: "700.00", lineCost: "1400.00" }),
    ]);
  });

  it("records who, when, why and every old and new value across several corrections, and never loses the original", async () => {
    const id = await twoPacks();
    const before = Date.now();

    const first = await draft(id, "One more pack was found");
    first.lines[0].quantity = "3";
    await correctReceipt(world.a.as.MANAGER, first);

    const second = await draft(id, "Price on invoice is 650");
    second.lines[0].unitCost = "650";
    second.invoiceNumber = "INV-9";
    await correctReceipt(world.a.as.ADMIN, second);

    const third = await draft(id, "It was two packs after all");
    third.lines[0].quantity = "2";
    expect(await correctReceipt(world.ownerInA, third)).toMatchObject({ version: 4 });

    const history = await getReceiptHistory(world.a.as.ACCOUNTANT, { receiptId: id });
    expect(history.map((version) => [version.version, version.savedByName, version.reason])).toEqual([
      [1, "Test a.admin", null],
      [2, "Test a.manager", "One more pack was found"],
      [3, "Test a.admin", "Price on invoice is 650"],
      [4, "Test owner", "It was two packs after all"],
    ]);
    for (const version of history) expect(version.savedAt.getTime()).toBeGreaterThanOrEqual(before - 2000);
    expect(history.map((version) => [version.lines[0].quantity, version.lines[0].unitCost, version.totalCost])).toEqual([
      ["2.000", "700.00", "1400.00"],
      ["3.000", "700.00", "2100.00"],
      ["3.000", "650.00", "1950.00"],
      ["2.000", "650.00", "1300.00"],
    ]);
    expect(history[1].changes).toEqual([
      expect.objectContaining({ lineNumber: 1, productName: "A Seed Sachet", label: "Arrived", oldValue: "2 pack", newValue: "3 pack" }),
      expect.objectContaining({ label: "Total cost", oldValue: "₦1,400.00", newValue: "₦2,100.00" }),
    ]);
    expect(history[2].changes.map((change) => [change.label, change.oldValue, change.newValue])).toEqual([
      ["Supplier's invoice", null, "INV-9"],
      ["Cost each", "₦700.00 per pack", "₦650.00 per pack"],
      ["Total cost", "₦2,100.00", "₦1,950.00"],
    ]);
    expect(history[1].stockEffects).toEqual([{ productName: "A Seed Sachet", locationName: "Storeroom", quantity: "10.000", unitName: "single" }]);
    expect(history[2].stockEffects).toEqual([]);
    expect(history[3].stockEffects).toEqual([{ productName: "A Seed Sachet", locationName: "Storeroom", quantity: "-10.000", unitName: "single" }]);

    // Stock ends where the last version says, by adding movements only: +20, +10, −10.
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("20.000");
    expect((await movementsOf(world.a.product.id)).map((movement) => movement.delta).sort()).toEqual(["-10.000", "10.000", "20.000"]);
    expect(await averageCost(world.a.product.id)).toBe("65.0000");

    // The list marks it, and each correction is in the activity log with its reason.
    expect((await listReceipts(world.a.as.ADMIN)).receipts[0]).toMatchObject({ version: 4 });
    const log = await getDb().activityLog.findMany({ where: { action: "stock.receipt_corrected" }, orderBy: { createdAt: "asc" } });
    expect(log).toHaveLength(3);
    expect(log[0].summary).toContain("GR-");
    expect(log[0].summary).toContain("Reason: One more pack was found");
    expect(log[0].actorName).toBe("Test a.manager");
  });

  it("cannot be changed or deleted, even directly in the database", async () => {
    const id = await twoPacks();
    const input = await draft(id);
    input.lines[0].quantity = "3";
    await correctReceipt(world.a.as.ADMIN, input);

    const db = getDb();
    const version = await db.goodsReceiptVersion.findFirstOrThrow({ where: { receiptId: id, version: 1 } });
    const versionLine = await db.goodsReceiptVersionLine.findFirstOrThrow({ where: { versionId: version.id } });
    const change = await db.goodsReceiptChange.findFirstOrThrow({ where: { receiptId: id } });
    const movement = await db.stockMovement.findFirstOrThrow({ where: { type: "RECEIPT_CORRECTION" } });

    await expect(db.goodsReceiptVersion.update({ where: { id: version.id }, data: { totalCost: "1" } })).rejects.toThrow();
    await expect(db.goodsReceiptVersion.delete({ where: { id: version.id } })).rejects.toThrow();
    await expect(db.goodsReceiptVersionLine.update({ where: { id: versionLine.id }, data: { quantity: "9" } })).rejects.toThrow();
    await expect(db.goodsReceiptVersionLine.delete({ where: { id: versionLine.id } })).rejects.toThrow();
    await expect(db.goodsReceiptChange.update({ where: { id: change.id }, data: { oldValue: "x" } })).rejects.toThrow();
    await expect(db.goodsReceiptChange.delete({ where: { id: change.id } })).rejects.toThrow();
    await expect(db.stockMovement.update({ where: { id: movement.id }, data: { quantityDelta: "1" } })).rejects.toThrow();
    await expect(db.stockMovement.delete({ where: { id: movement.id } })).rejects.toThrow();

    // The delivery itself: never deleted, never renumbered, and never changed without a new version.
    await expect(db.goodsReceipt.delete({ where: { id } })).rejects.toThrow();
    await expect(db.goodsReceipt.update({ where: { id }, data: { totalCost: "1" } })).rejects.toThrow();
    await expect(db.goodsReceipt.update({ where: { id }, data: { version: { increment: 2 } } })).rejects.toThrow();
    await expect(db.goodsReceipt.update({ where: { id }, data: { version: { increment: 1 }, number: 99 } })).rejects.toThrow();
    // A correction with no reason cannot exist.
    await expect(
      db.goodsReceiptVersion.create({ data: { ...version, id: randomUUID(), version: 3, reason: " " } }),
    ).rejects.toThrow();
  });

  it("gives deliveries saved before this feature their original snapshot, and they can then be corrected", async () => {
    const id = await twoPacks();
    const db = getDb();
    // Put the database in the state an older delivery was in: no snapshot at all…
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
      await tx.$executeRawUnsafe("TRUNCATE TABLE `goods_receipt_version_line`");
      await tx.$executeRawUnsafe("TRUNCATE TABLE `goods_receipt_version`");
      await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
    });
    // …then run the very statements the database update runs on existing deliveries.
    const folder = readdirSync("prisma/migrations").find((name) => name.endsWith("_delivery_corrections"))!;
    const sql = readFileSync(join("prisma/migrations", folder, "migration.sql"), "utf8");
    const backfill = sql.slice(sql.indexOf("INSERT INTO `goods_receipt_version`"));
    for (const statement of backfill.split(";").map((part) => part.trim()).filter(Boolean)) {
      await db.$executeRawUnsafe(statement);
    }

    const [original] = await getReceiptHistory(world.a.as.ADMIN, { receiptId: id });
    const receipt = await getReceipt(world.a.as.ADMIN, { receiptId: id });
    expect(original).toMatchObject({ version: 1, reason: null, savedByName: receipt.createdByName, supplierName: receipt.supplierName, totalCost: receipt.totalCost });
    expect(original.savedAt).toEqual(receipt.createdAt);
    expect(original.lines).toEqual(receipt.lines.map((line) => expect.objectContaining({ lineNumber: line.lineNumber, quantity: line.quantity, unitCost: line.unitCost, lineCost: line.lineCost })));

    const input = await draft(id);
    input.lines[0].quantity = "5";
    expect(await correctReceipt(world.a.as.ADMIN, input)).toMatchObject({ version: 2 });
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("50.000");
    expect(await getReceiptHistory(world.a.as.ADMIN, { receiptId: id })).toHaveLength(2);
  });
});

describe("who may correct a delivery", () => {
  it("lets an admin, a manager and an owner; refuses the storekeeper, cashier and accountant", async () => {
    const id = await twoPacks();
    for (const role of ["STOREKEEPER", "CASHIER", "ACCOUNTANT"] as const) {
      const input = await draft(id);
      input.lines[0].quantity = "9";
      await expect(correctReceipt(world.a.as[role], input)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getCorrectionOptions(world.a.as[role], { receiptId: id })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("20.000");
    expect(await getDb().goodsReceiptVersion.count()).toBe(1);

    let quantity = 3;
    for (const context of [world.a.as.ADMIN, world.a.as.MANAGER, world.ownerInA]) {
      const input = await draft(id);
      input.lines[0].quantity = String(quantity++);
      await correctReceipt(context, input);
    }
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("50.000");
    // An owner with no business open has nothing to correct.
    await expect(correctReceipt(world.ownerOutside, await draft(id))).rejects.toThrow();
  });

  it("keeps businesses apart: B cannot correct or read A's delivery, and A cannot use B's records", async () => {
    const id = await twoPacks();
    const input = await draft(id);
    input.lines[0].quantity = "3";
    const contexts: AppContext[] = [world.b.as.ADMIN, world.b.as.MANAGER];
    for (const context of contexts) {
      await expect(correctReceipt(context, input)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getCorrectionOptions(context, { receiptId: id })).rejects.toBeInstanceOf(NotFoundError);
      await expect(getReceiptHistory(context, { receiptId: id })).rejects.toBeInstanceOf(NotFoundError);
    }

    const foreign = await draft(id);
    foreign.supplierId = world.b.supplierId;
    foreign.locationId = world.b.shelfId;
    foreign.lines.push({ lineNumber: null, productId: world.b.product.id, unitId: world.b.product.packUnitId, quantity: "1", unitCost: "1" });
    const errors = (await refusal(correctReceipt(world.a.as.ADMIN, foreign))).fieldErrors;
    expect(Object.keys(errors).sort()).toEqual(["lines.1.productId", "locationId", "supplierId"]);
    expect(await getDb().stockBalance.count({ where: { businessId: world.b.id } })).toBe(0);
    expect(await getDb().goodsReceiptVersion.count()).toBe(1);
  });
});

describe("corrections that are refused, with nothing saved", () => {
  it("refuses a correction that would leave less than nothing in the location", async () => {
    const id = await twoPacks();
    await goodsLeave(world.a.product.id, world.a.storeroomId, "15");
    const before = await everything();

    const input = await draft(id);
    input.lines[0].quantity = "1";
    const error = await refusal(correctReceipt(world.a.as.ADMIN, input));
    expect(error.message).toContain("Nothing was saved");
    expect(error.message).toContain('take 10 single of "A Seed Sachet" out of Storeroom, but only 5 single is there now');
    expect(await everything()).toBe(before);

    // Taking away exactly what is left is allowed.
    const exact = await draft(id);
    exact.lines[0] = { ...exact.lines[0], unitId: world.a.product.baseUnitId, quantity: "15", unitCost: "70" };
    await correctReceipt(world.a.as.ADMIN, exact);
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("0.000");
  });

  it("refuses to move a delivery to another location, or remove a line, once the goods have left", async () => {
    const sprayer = await secondProduct();
    const id = await deliver([
      { productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "2", unitCost: "700" },
      { productId: sprayer.productId, unitId: sprayer.pieceId, quantity: "4", unitCost: "3000" },
    ]);
    await goodsLeave(sprayer.productId, world.a.storeroomId, "1");
    const before = await everything();

    const moved = await draft(id);
    moved.locationId = world.a.shelfId;
    expect((await refusal(correctReceipt(world.a.as.ADMIN, moved))).message).toContain('"Hand Sprayer" out of Storeroom');

    const removed = await draft(id);
    removed.lines = [removed.lines[0]];
    expect((await refusal(correctReceipt(world.a.as.ADMIN, removed))).message).toContain("only 3 piece is there now");

    // Everything is as it was — including the sachets, whose part of the move was undone.
    expect(await everything()).toBe(before);
  });

  it("requires a reason", async () => {
    const id = await twoPacks();
    for (const reason of ["", "   ", "oops"]) {
      const input = await draft(id, reason);
      input.lines[0].quantity = "3";
      expect((await refusal(correctReceipt(world.a.as.ADMIN, input))).fieldErrors.reason).toMatch(/Explain why/);
    }
    expect(await getDb().goodsReceiptVersion.count()).toBe(1);
  });

  it("refuses a correction that changes nothing", async () => {
    const id = await twoPacks();
    const before = await everything();
    expect((await refusal(correctReceipt(world.a.as.ADMIN, await draft(id)))).message).toMatch(/Nothing was changed/);
    // Writing the same amounts another way is still no change.
    const same = await draft(id);
    same.lines[0].quantity = "2.000";
    same.lines[0].unitCost = "700";
    expect((await refusal(correctReceipt(world.a.as.ADMIN, same))).message).toMatch(/Nothing was changed/);
    expect(await everything()).toBe(before);
  });

  it("refuses impossible values and saves nothing, even when another line is fine", async () => {
    const sprayer = await secondProduct();
    const id = await deliver([
      { productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "2", unitCost: "700" },
      { productId: sprayer.productId, unitId: sprayer.pieceId, quantity: "4", unitCost: "3000" },
    ]);
    const before = await everything();

    const attempt = async (change: (input: Correction) => void) => {
      const input = await draft(id);
      input.lines[0].quantity = "5";
      change(input);
      return (await refusal(correctReceipt(world.a.as.ADMIN, input))).fieldErrors;
    };

    expect(await attempt((input) => (input.lines[1].quantity = "0"))).toHaveProperty(["lines.1.quantity"]);
    expect(await attempt((input) => (input.lines[1].quantity = "-3"))).toHaveProperty(["lines.1.quantity"]);
    expect(await attempt((input) => (input.lines[1].quantity = "2.5"))).toHaveProperty(["lines.1.quantity"]);
    expect(await attempt((input) => (input.lines[1].quantity = "four"))).toHaveProperty(["lines.1.quantity"]);
    expect(await attempt((input) => (input.lines[1].unitCost = "-1"))).toHaveProperty(["lines.1.unitCost"]);
    expect(await attempt((input) => (input.lines[1].unitCost = "1,000"))).toHaveProperty(["lines.1.unitCost"]);
    expect(await attempt((input) => (input.lines[1].unitId = world.a.product.packUnitId))).toHaveProperty(["lines.1.unitId"]);
    expect(await attempt((input) => (input.lines[1].productId = world.a.product.id))).toHaveProperty(["lines.1.productId"]);
    expect(await attempt((input) => (input.lines[1].lineNumber = 7))).toHaveProperty(["lines.1.productId"]);
    expect(await attempt((input) => (input.lines[1].lineNumber = 1))).toHaveProperty(["lines.1.productId"]);
    expect(await attempt((input) => (input.lines[1].expiryDate = "2030-01-01"))).toHaveProperty(["lines.1.expiryDate"]);
    expect(await attempt((input) => (input.receivedOn = addMonths(shopToday(), 1)))).toHaveProperty("receivedOn");
    expect(await attempt((input) => (input.receivedOn = "2026-02-31"))).toHaveProperty("receivedOn");
    expect(await attempt((input) => (input.receivedOn = addMonths(shopToday(), -14)))).toHaveProperty("receivedOn");
    expect(await attempt((input) => (input.lines = []))).toHaveProperty("lines");
    expect(await attempt((input) => (input.requestId = "not-an-id"))).toHaveProperty("requestId");

    expect(await everything()).toBe(before);
  });

  it("answers 'not found' for a delivery that does not exist", async () => {
    const id = await twoPacks();
    const input = await draft(id);
    input.receiptId = randomUUID();
    await expect(correctReceipt(world.a.as.ADMIN, input)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("several people at once, and repeated submissions", () => {
  it("applies the same correction once when it is sent twice", async () => {
    const id = await twoPacks();
    const input = await draft(id);
    input.lines[0].quantity = "3";

    const first = await correctReceipt(world.a.as.ADMIN, input);
    const again = await correctReceipt(world.a.as.ADMIN, input);
    expect(first).toMatchObject({ version: 2, alreadySaved: false });
    expect(again).toMatchObject({ id, version: 2, alreadySaved: true });
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("30.000");
    expect(await getDb().goodsReceiptVersion.count()).toBe(2);
  });

  it("applies it once when the same correction arrives twice at the same instant", async () => {
    const id = await twoPacks();
    const input = await draft(id);
    input.lines[0].quantity = "3";

    const results = await Promise.all([correctReceipt(world.a.as.ADMIN, input), correctReceipt(world.a.as.ADMIN, input)]);
    expect(results.map((result) => result.version)).toEqual([2, 2]);
    expect(results.filter((result) => !result.alreadySaved)).toHaveLength(1);
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("30.000");
    expect(await getDb().stockMovement.count()).toBe(2);
  });

  it("saves one and refuses the other when two people correct the same delivery at the same instant", async () => {
    const id = await twoPacks();
    const mine = await draft(id, "I counted five packs");
    mine.lines[0].quantity = "5";
    const theirs = await draft(id, "I counted seven packs");
    theirs.lines[0].quantity = "7";

    const outcomes = await Promise.allSettled([correctReceipt(world.a.as.ADMIN, mine), correctReceipt(world.a.as.MANAGER, theirs)]);
    const saved = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(saved).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ValidationError);
    expect(refused[0].reason.message).toContain("Someone else corrected this delivery");

    const receipt = await getReceipt(world.a.as.ADMIN, { receiptId: id });
    expect(receipt.version).toBe(2);
    // Stock matches whichever one was saved — never the two laid on top of each other.
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe(receipt.lines[0].baseQuantity);
    expect(await getDb().goodsReceiptVersion.count()).toBe(2);
  });

  it("refuses a correction made from a page that is out of date", async () => {
    const id = await twoPacks();
    const stale = await draft(id);
    stale.lines[0].quantity = "9";

    const fresh = await draft(id);
    fresh.lines[0].quantity = "3";
    await correctReceipt(world.a.as.ADMIN, fresh);

    expect((await refusal(correctReceipt(world.a.as.MANAGER, stale))).message).toContain("Reload the page");
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("30.000");
  });

  it("stays exact when a correction and new deliveries of the same product are saved at the same instant", async () => {
    const single = { productId: world.a.product.id, unitId: world.a.product.baseUnitId };
    const id = await deliver([{ ...single, quantity: "100", unitCost: "50" }]);
    const other = await deliver([{ ...single, quantity: "100", unitCost: "50" }]);

    const down = await draft(id);
    down.lines[0].quantity = "40";
    const up = await draft(other);
    up.lines[0].quantity = "130";
    await Promise.all([
      correctReceipt(world.a.as.ADMIN, down),
      correctReceipt(world.a.as.MANAGER, up),
      deliver([{ ...single, quantity: "30", unitCost: "50" }]),
      deliver([{ ...single, quantity: "50", unitCost: "50" }], { locationId: world.a.shelfId }),
    ]);

    // 100 + 100 − 60 + 30 + 30 in the Storeroom, 50 on the Shelf; everything cost 50.
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("200.000");
    expect(await quantityAt(world.a.product.id, world.a.shelfId)).toBe("50.000");
    expect(await averageCost(world.a.product.id)).toBe("50.0000");
  });

  it("never lets two corrections together take out more than is there", async () => {
    const single = { productId: world.a.product.id, unitId: world.a.product.baseUnitId };
    const first = await deliver([{ ...single, quantity: "10", unitCost: "50" }]);
    const second = await deliver([{ ...single, quantity: "10", unitCost: "50" }]);
    await goodsLeave(world.a.product.id, world.a.storeroomId, "12");

    // 8 left. Each correction alone (−6) fits; both together (−12) do not.
    const one = await draft(first);
    one.lines[0].quantity = "4";
    const two = await draft(second);
    two.lines[0].quantity = "4";
    const outcomes = await Promise.allSettled([correctReceipt(world.a.as.ADMIN, one), correctReceipt(world.a.as.MANAGER, two)]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("2.000");
    expect(await getDb().goodsReceiptVersion.count()).toBe(3);
  });
});
