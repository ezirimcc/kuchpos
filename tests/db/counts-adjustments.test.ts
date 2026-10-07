import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUnit, createProduct, setProductActive } from "@/server/business/catalog";
import {
  adjustFromCount,
  decideAdjustment,
  getAdjustment,
  getAdjustmentOptions,
  listAdjustments,
  recordAdjustment,
} from "@/server/business/adjustments";
import { getCount, getCountSheet, listCounts, submitCount } from "@/server/business/counts";
import { receiveGoods } from "@/server/business/stock";
import { transferStock } from "@/server/business/transfers";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, nextDocumentNumber, type World } from "../support/world";

/** Stock counts, adjustments with reasons, and approval of a storekeeper's adjustments. */

let world: World;
let cartonId = "";

beforeEach(async () => {
  world = await createWorld();
  // single = 1, pack = 10 (from the fixtures) and carton = 100; one carton (100 singles) in the Storeroom at ₦50 each.
  cartonId = (
    await addUnit(world.a.as.ADMIN, { productId: world.a.product.id, name: "carton", factor: "100", forSale: true, forPurchase: true, price: "8500" })
  ).id;
  await receiveGoods(world.a.as.ADMIN, {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.storeroomId,
    lines: [{ productId: world.a.product.id, unitId: cartonId, quantity: "1", unitCost: "5000" }],
  });
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

const sachet = () => world.a.product.id;
const single = () => world.a.product.baseUnitId;

async function inStoreroom(productId = sachet()): Promise<string> {
  const balance = await getDb().stockBalance.findUnique({ where: { productId_locationId: { productId, locationId: world.a.storeroomId } } });
  return balance ? balance.quantity.toFixed(3) : "0.000";
}

type AdjustLine = { productId: string; unitId: string; direction: "add" | "remove"; quantity: string; reason: string };
const take = (quantity: string, reason = "DAMAGED", unitId = single()): AdjustLine => ({ productId: sachet(), unitId, direction: "remove", quantity, reason });
const add = (quantity: string, reason = "FOUND", unitId = single()): AdjustLine => ({ productId: sachet(), unitId, direction: "add", quantity, reason });

function adjustment(lines: AdjustLine[], extra: Record<string, unknown> = {}) {
  return { requestId: randomUUID(), locationId: world.a.storeroomId, note: "", lines, ...extra };
}

type Entry = { unitId: string; quantity: string };
function count(entries: Entry[], extra: Record<string, unknown> = {}) {
  return { requestId: randomUUID(), locationId: world.a.storeroomId, lines: [{ productId: sachet(), entries }], ...extra };
}

/** A count of 95 singles where the system holds 100. */
const countedNinetyFive = (as = world.a.as.STOREKEEPER) => submitCount(as, count([{ unitId: single(), quantity: "95" }]));

/** Stands in for a sale or any other movement between counting and applying: 10 singles go to the Shelf. */
const tenLeaveTheStoreroom = () =>
  transferStock(world.a.as.ADMIN, {
    requestId: randomUUID(),
    fromLocationId: world.a.storeroomId,
    toLocationId: world.a.shelfId,
    lines: [{ productId: sachet(), unitId: single(), quantity: "10" }],
  });

async function everything() {
  const db = getDb();
  return JSON.stringify({
    counts: await db.stockCount.count(),
    countLines: await db.stockCountLine.count(),
    adjustments: await db.stockAdjustment.count(),
    adjustmentLines: await db.stockAdjustmentLine.count(),
    decisions: await db.stockAdjustmentDecision.count(),
    movements: await db.stockMovement.findMany({ orderBy: { id: "asc" } }),
    balances: await db.stockBalance.findMany({ orderBy: { id: "asc" } }),
    numbers: [await nextDocumentNumber(world.a.id, "STOCK_COUNT"), await nextDocumentNumber(world.a.id, "STOCK_ADJUSTMENT")],
    activity: await db.activityLog.count(),
  });
}

describe("a stock count", () => {
  it("is blind: the sheet lists products and units but no stock figures", async () => {
    const sheet = await getCountSheet(world.a.as.STOREKEEPER);
    expect(sheet.locations.map((location) => location.name).sort()).toEqual(["Shelf", "Storeroom"]);
    expect(sheet.products).toHaveLength(1);
    expect(sheet.products[0]).toMatchObject({ name: "A Seed Sachet", baseUnitName: "single", category: "Seeds" });
    expect(sheet.products[0].units.map((unit) => unit.name)).toEqual(["carton", "pack", "single"]);
    expect(Object.keys(sheet.products[0])).not.toContain("stock");

    // Narrowed to a category.
    expect((await getCountSheet(world.a.as.STOREKEEPER, { category: world.a.emptyCategoryId })).products).toEqual([]);
    expect((await getCountSheet(world.a.as.STOREKEEPER, { category: world.a.categoryId })).products).toHaveLength(1);
  });

  it("counting 95 where the system expects 100 records a difference of −5 and changes no stock", async () => {
    const saved = await countedNinetyFive();
    expect(saved).toMatchObject({ number: 1, alreadySaved: false });

    const detail = await getCount(world.a.as.STOREKEEPER, { countId: saved.id });
    expect(detail).toMatchObject({ locationName: "Storeroom", categoryName: null, productCount: 1, differences: 1, adjustment: null, canAdjust: true, appliesAtOnce: false, createdByName: "Test a.storekeeper" });
    expect(detail.lines).toEqual([
      { lineNumber: 1, productId: sachet(), productName: "A Seed Sachet", baseUnitName: "single", enteredAs: "95 single", counted: "95.000", expected: "100.000", difference: "-5.000" },
    ]);
    expect(await inStoreroom()).toBe("100.000");
    expect(await getDb().stockMovement.count()).toBe(1);
  });

  it("adds up what was entered in several units: 1 pack fewer than a carton is 9 packs, entered as packs and singles", async () => {
    const { id } = await submitCount(world.a.as.ADMIN, count([{ unitId: single(), quantity: "7" }, { unitId: world.a.product.packUnitId, quantity: "8" }, { unitId: cartonId, quantity: "0" }]));
    const [line] = (await getCount(world.a.as.ADMIN, { countId: id })).lines;
    expect(line).toMatchObject({ enteredAs: "8 pack + 7 single", counted: "87.000", expected: "100.000", difference: "-13.000" });
  });

  it("treats an explicit zero as counted, a product never stocked as expecting zero, and a match as no difference", async () => {
    const zero = await submitCount(world.a.as.ADMIN, count([{ unitId: single(), quantity: "0" }], { locationId: world.a.shelfId }));
    const onShelf = await getCount(world.a.as.ADMIN, { countId: zero.id });
    expect(onShelf.lines[0]).toMatchObject({ enteredAs: "0 single", counted: "0.000", expected: "0.000", difference: "0.000" });
    expect(onShelf).toMatchObject({ differences: 0, canAdjust: false });

    const exact = await submitCount(world.a.as.ADMIN, count([{ unitId: cartonId, quantity: "1" }]));
    expect((await getCount(world.a.as.ADMIN, { countId: exact.id })).differences).toBe(0);
    await expect(adjustFromCount(world.a.as.ADMIN, { requestId: randomUUID(), countId: exact.id, reasons: [] })).rejects.toThrow(/no differences/);
  });

  it("records the category it was narrowed to, and is saved once when sent twice", async () => {
    const request = count([{ unitId: single(), quantity: "95" }], { category: world.a.categoryId, note: "Morning count" });
    const first = await submitCount(world.a.as.STOREKEEPER, request);
    const again = await submitCount(world.a.as.STOREKEEPER, request);
    expect(again).toEqual({ ...first, alreadySaved: true });
    const both = await Promise.all([submitCount(world.a.as.ADMIN, count([{ unitId: single(), quantity: "1" }], { requestId: request.requestId })), 0]);
    expect(both[0].alreadySaved).toBe(true);

    expect(await getDb().stockCount.count()).toBe(1);
    expect(await getCount(world.a.as.ADMIN, { countId: first.id })).toMatchObject({ categoryName: "Seeds", note: "Morning count" });
  });

  it("refuses bad counts and saves nothing", async () => {
    const before = await everything();
    const attempt = async (input: Record<string, unknown>) => Object.keys((await refusal(submitCount(world.a.as.ADMIN, input))).fieldErrors);
    const line = `lines.${sachet()}`;

    for (const quantity of ["-1", "2.5", "many", "1,000", "1.2345"]) {
      expect(await attempt(count([{ unitId: single(), quantity }])), quantity).toEqual([line]);
    }
    expect(await attempt(count([]))).toEqual([line]);
    expect(await attempt(count([{ unitId: randomUUID(), quantity: "1" }]))).toEqual([line]);
    expect(await attempt(count([{ unitId: world.b.product.baseUnitId, quantity: "1" }]))).toEqual([line]);
    expect(await attempt({ ...count([{ unitId: single(), quantity: "1" }]), lines: [] })).toEqual(["lines"]);
    expect(await attempt(count([{ unitId: single(), quantity: "1" }], { locationId: world.b.storeroomId }))).toEqual(["locationId"]);
    expect(await attempt(count([{ unitId: single(), quantity: "1" }], { category: world.b.categoryId }))).toEqual(["category"]);
    expect(await attempt({ ...count([]), lines: [{ productId: world.b.product.id, entries: [{ unitId: world.b.product.baseUnitId, quantity: "1" }] }] })).toEqual([`lines.${world.b.product.id}`]);
    const twice = { productId: sachet(), entries: [{ unitId: single(), quantity: "1" }] };
    expect(await attempt({ ...count([]), lines: [twice, twice] })).toEqual([line]);

    expect(await everything()).toBe(before);
  });

  it("lists counts newest first with how many products did not match, and cannot be altered in the database", async () => {
    const first = await countedNinetyFive();
    await submitCount(world.a.as.ADMIN, count([{ unitId: cartonId, quantity: "1" }]));

    const list = await listCounts(world.a.as.ACCOUNTANT);
    expect(list.canCount).toBe(false);
    expect(list.counts.map((row) => [row.number, row.productCount, row.differences, row.createdByName])).toEqual([
      [2, 1, 0, "Test a.admin"],
      [1, 1, 1, "Test a.storekeeper"],
    ]);
    expect((await listCounts(world.a.as.ADMIN, { search: "SC-000001" })).counts.map((row) => row.number)).toEqual([1]);
    expect((await listCounts(world.a.as.ADMIN, { search: "storekeeper" })).counts.map((row) => row.number)).toEqual([1]);
    expect((await listCounts(world.a.as.ADMIN, { to: "2020-01-01" })).counts).toEqual([]);

    const db = getDb();
    const line = await db.stockCountLine.findFirstOrThrow({ where: { countId: first.id } });
    await expect(db.stockCount.update({ where: { id: first.id }, data: { note: "x" } })).rejects.toThrow();
    await expect(db.stockCount.delete({ where: { id: first.id } })).rejects.toThrow();
    await expect(db.stockCountLine.update({ where: { id: line.id }, data: { enteredAs: "x" } })).rejects.toThrow();
    await expect(db.stockCountLine.delete({ where: { id: line.id } })).rejects.toThrow();
    // A count line whose difference is not "counted minus expected" cannot exist.
    await expect(
      db.stockCountLine.create({ data: { ...line, id: randomUUID(), lineNumber: 9, productId: world.b.product.id, difference: "1" } }),
    ).rejects.toThrow();
  });
});

describe("an adjustment by an admin or manager", () => {
  it("changes stock at once, with a movement per line, and leaves the average cost alone", async () => {
    const saved = await recordAdjustment(world.a.as.MANAGER, adjustment([take("5"), add("1", "FOUND", world.a.product.packUnitId)], { note: "Rats got into one pack" }));
    expect(saved).toMatchObject({ number: 1, status: "APPLIED", alreadySaved: false });

    expect(await inStoreroom()).toBe("105.000");
    const movements = await getDb().stockMovement.findMany({ where: { documentId: saved.id }, orderBy: { quantityDelta: "asc" } });
    expect(movements.map((movement) => [movement.type, movement.quantityDelta.toFixed(3), movement.unitName, movement.unitQuantity.toFixed(3), movement.documentNumber, movement.userName])).toEqual([
      ["ADJUSTMENT", "-5.000", "single", "-5.000", "AD-000001", "Test a.manager"],
      ["ADJUSTMENT", "10.000", "pack", "1.000", "AD-000001", "Test a.manager"],
    ]);
    expect((await getDb().product.findUniqueOrThrow({ where: { id: sachet() } })).averageCost.toFixed(4)).toBe("50.0000");

    const detail = await getAdjustment(world.a.as.ACCOUNTANT, { adjustmentId: saved.id });
    expect(detail).toMatchObject({ status: "APPLIED", note: "Rats got into one pack", createdByName: "Test a.manager", decidedByName: "Test a.manager", canDecide: false, count: null });
    expect(detail.lines.map((line) => [line.quantity, line.unitName, line.baseQuantity, line.reason, line.stockNow])).toEqual([
      ["-5.000", "single", "-5.000", "DAMAGED", null],
      ["1.000", "pack", "10.000", "FOUND", null],
    ]);
    const log = await getDb().activityLog.findFirstOrThrow({ where: { action: "stock.adjusted" } });
    expect(log.summary).toBe("Test a.manager adjusted stock in Storeroom (AD-000001): −5 single of A Seed Sachet (Damaged), +1 pack of A Seed Sachet (Found). Note: Rats got into one pack");
  });

  it("can add stock to a location that had none, and take out exactly what is left", async () => {
    await recordAdjustment(world.a.as.ADMIN, adjustment([add("3")], { locationId: world.a.shelfId }));
    await recordAdjustment(world.a.as.ADMIN, adjustment([take("1", "EXPIRED", cartonId)]));
    expect(await inStoreroom()).toBe("0.000");
    const shelf = await getDb().stockBalance.findUniqueOrThrow({ where: { productId_locationId: { productId: sachet(), locationId: world.a.shelfId } } });
    expect(shelf.quantity.toFixed(3)).toBe("3.000");
  });

  it("is refused whole if it would take out more than is there", async () => {
    const before = await everything();
    const error = await refusal(recordAdjustment(world.a.as.ADMIN, adjustment([take("101")])));
    expect(error.message).toBe('Stock was not changed. Only 100 single of "A Seed Sachet" is in Storeroom. This adjustment takes out 101 single.');
    expect(Object.keys(error.fieldErrors)).toEqual(["lines.0.quantity"]);
    expect(await everything()).toBe(before);

    // Lines of one product are added together first: −101 +1 is −100, which fits.
    await recordAdjustment(world.a.as.ADMIN, adjustment([take("101"), add("1")]));
    expect(await inStoreroom()).toBe("0.000");
  });

  it("is saved once when sent twice, also at the same instant", async () => {
    const request = adjustment([take("5")]);
    const first = await recordAdjustment(world.a.as.ADMIN, request);
    expect(await recordAdjustment(world.a.as.ADMIN, request)).toEqual({ ...first, alreadySaved: true });

    const other = adjustment([take("1")]);
    const results = await Promise.all([recordAdjustment(world.a.as.ADMIN, other), recordAdjustment(world.a.as.ADMIN, other)]);
    expect(results.filter((result) => !result.alreadySaved)).toHaveLength(1);
    expect(await inStoreroom()).toBe("94.000");
    expect(await getDb().stockAdjustment.count()).toBe(2);
  });
});

describe("reasons and other checks", () => {
  it("refuses an adjustment without a reason, with an unknown reason, or with 'Other' and no note", async () => {
    const before = await everything();
    const attempt = async (input: Record<string, unknown>) => Object.keys((await refusal(recordAdjustment(world.a.as.ADMIN, input))).fieldErrors);

    expect(await attempt(adjustment([{ ...take("5"), reason: "" }]))).toEqual(["lines.0.reason"]);
    expect(await attempt(adjustment([{ ...take("5"), reason: "BORED" }]))).toEqual(["lines.0.reason"]);
    const noReason: Partial<AdjustLine> = take("5");
    delete noReason.reason;
    expect(await attempt(adjustment([noReason as AdjustLine]))).toEqual(["lines.0.reason"]);
    expect(await attempt(adjustment([take("5", "OTHER")]))).toEqual(["note"]);
    expect(await attempt(adjustment([take("5", "OTHER")], { note: "eh" }))).toEqual(["note"]);
    expect(await everything()).toBe(before);

    await recordAdjustment(world.a.as.ADMIN, adjustment([take("5", "OTHER")], { note: "Given to the church harvest" }));
    expect(await inStoreroom()).toBe("95.000");
  });

  it("refuses bad amounts, directions, units, products and locations, and saves nothing", async () => {
    const before = await everything();
    const attempt = async (input: Record<string, unknown>) => Object.keys((await refusal(recordAdjustment(world.a.as.ADMIN, input))).fieldErrors);

    for (const quantity of ["0", "-5", "2.5", "five", ""]) {
      expect(await attempt(adjustment([take(quantity)])), quantity).toEqual(["lines.0.quantity"]);
    }
    expect(await attempt(adjustment([{ ...take("1"), direction: "sideways" as "add" }]))).toEqual(["lines.0.direction"]);
    expect(await attempt(adjustment([take("1", "DAMAGED", randomUUID())]))).toEqual(["lines.0.unitId"]);
    expect(await attempt(adjustment([take("1", "DAMAGED", world.b.product.baseUnitId)]))).toEqual(["lines.0.unitId"]);
    expect(await attempt(adjustment([{ ...take("1"), productId: world.b.product.id, unitId: world.b.product.baseUnitId }]))).toEqual(["lines.0.productId"]);
    expect(await attempt(adjustment([take("1")], { locationId: world.b.storeroomId }))).toEqual(["locationId"]);
    expect(await attempt(adjustment([]))).toEqual(["lines"]);
    expect(await attempt(adjustment([take("1")], { requestId: "x" }))).toEqual(["requestId"]);
    expect(await everything()).toBe(before);

    await setProductActive(world.a.as.ADMIN, { productId: sachet(), active: false });
    expect(await attempt(adjustment([take("1")]))).toEqual(["lines.0.productId"]);
  });
});

describe("a storekeeper's adjustment waits for approval", () => {
  it("does not change stock until a manager approves it", async () => {
    const saved = await recordAdjustment(world.a.as.STOREKEEPER, adjustment([take("5")]));
    expect(saved).toMatchObject({ status: "PENDING" });
    expect(await inStoreroom()).toBe("100.000");
    expect(await getDb().stockMovement.count()).toBe(1);

    const waiting = await getAdjustment(world.a.as.MANAGER, { adjustmentId: saved.id });
    expect(waiting).toMatchObject({ status: "PENDING", canDecide: true, decidedByName: null });
    expect(waiting.lines[0].stockNow).toBe("100.000");
    expect((await getAdjustment(world.a.as.STOREKEEPER, { adjustmentId: saved.id })).canDecide).toBe(false);
    expect((await listAdjustments(world.a.as.MANAGER)).waiting).toBe(1);

    const decided = await decideAdjustment(world.a.as.MANAGER, { adjustmentId: saved.id, outcome: "APPLIED" });
    expect(decided).toMatchObject({ status: "APPLIED", alreadyDecided: false });
    expect(await inStoreroom()).toBe("95.000");

    const movement = await getDb().stockMovement.findFirstOrThrow({ where: { documentId: saved.id } });
    expect([movement.type, movement.quantityDelta.toFixed(3), movement.userName]).toEqual(["ADJUSTMENT", "-5.000", "Test a.manager"]);
    expect(await getAdjustment(world.a.as.STOREKEEPER, { adjustmentId: saved.id })).toMatchObject({ status: "APPLIED", createdByName: "Test a.storekeeper", decidedByName: "Test a.manager" });
    expect((await listAdjustments(world.a.as.MANAGER)).waiting).toBe(0);

    const actions = (await getDb().activityLog.findMany({ where: { targetId: saved.id }, orderBy: { createdAt: "asc" } })).map((entry) => entry.action);
    expect(actions).toEqual(["stock.adjustment_requested", "stock.adjustment_approved"]);
  });

  it("changes nothing when rejected, needs a reason for the rejection, and can then not be approved", async () => {
    const saved = await recordAdjustment(world.a.as.STOREKEEPER, adjustment([take("5", "MISSING")]));
    expect((await refusal(decideAdjustment(world.a.as.ADMIN, { adjustmentId: saved.id, outcome: "REJECTED", note: "no" }))).fieldErrors).toHaveProperty("note");

    await decideAdjustment(world.a.as.ADMIN, { adjustmentId: saved.id, outcome: "REJECTED", note: "Count again with me present" });
    expect(await inStoreroom()).toBe("100.000");
    expect(await getDb().stockMovement.count()).toBe(1);
    expect(await getAdjustment(world.a.as.STOREKEEPER, { adjustmentId: saved.id })).toMatchObject({ status: "REJECTED", decidedByName: "Test a.admin", decisionNote: "Count again with me present" });

    const error = await refusal(decideAdjustment(world.a.as.MANAGER, { adjustmentId: saved.id, outcome: "APPLIED" }));
    expect(error.message).toBe("This adjustment was already rejected by Test a.admin. Nothing was changed.");
    // The same decision again is harmless.
    expect(await decideAdjustment(world.a.as.MANAGER, { adjustmentId: saved.id, outcome: "REJECTED", note: "Count again with me present" })).toMatchObject({ alreadyDecided: true });
    expect(await getDb().stockAdjustmentDecision.count()).toBe(1);
  });

  it("is applied exactly once when two people approve at the same instant, and once when one approves and one rejects", async () => {
    const first = await recordAdjustment(world.a.as.STOREKEEPER, adjustment([take("5")]));
    const results = await Promise.all([
      decideAdjustment(world.a.as.MANAGER, { adjustmentId: first.id, outcome: "APPLIED" }),
      decideAdjustment(world.a.as.ADMIN, { adjustmentId: first.id, outcome: "APPLIED" }),
      decideAdjustment(world.ownerInA, { adjustmentId: first.id, outcome: "APPLIED" }),
    ]);
    expect(results.filter((result) => !result.alreadyDecided)).toHaveLength(1);
    expect(await inStoreroom()).toBe("95.000");
    expect(await getDb().stockMovement.count({ where: { documentId: first.id } })).toBe(1);

    const second = await recordAdjustment(world.a.as.STOREKEEPER, adjustment([take("7")]));
    const outcomes = await Promise.allSettled([
      decideAdjustment(world.a.as.MANAGER, { adjustmentId: second.id, outcome: "APPLIED" }),
      decideAdjustment(world.a.as.ADMIN, { adjustmentId: second.id, outcome: "REJECTED", note: "Not convinced" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const status = (await getAdjustment(world.a.as.ADMIN, { adjustmentId: second.id })).status;
    expect(await inStoreroom()).toBe(status === "APPLIED" ? "88.000" : "95.000");
    expect(await getDb().stockAdjustmentDecision.count()).toBe(2);
  });

  it("cannot be approved if the stock is no longer there, and stays waiting so it can be rejected", async () => {
    const saved = await recordAdjustment(world.a.as.STOREKEEPER, adjustment([take("95")]));
    await tenLeaveTheStoreroom();
    const before = await everything();

    const error = await refusal(decideAdjustment(world.a.as.MANAGER, { adjustmentId: saved.id, outcome: "APPLIED" }));
    expect(error.message).toBe('Stock was not changed. Only 90 single of "A Seed Sachet" is in Storeroom. This adjustment takes out 95 single.');
    expect(await everything()).toBe(before);
    expect((await getAdjustment(world.a.as.MANAGER, { adjustmentId: saved.id })).status).toBe("PENDING");

    await decideAdjustment(world.a.as.MANAGER, { adjustmentId: saved.id, outcome: "REJECTED", note: "Stock has moved; count again" });
    expect(await inStoreroom()).toBe("90.000");
  });

  it("never lets two approvals together take out more than is there", async () => {
    const one = await recordAdjustment(world.a.as.STOREKEEPER, adjustment([take("60")]));
    const two = await recordAdjustment(world.a.as.STOREKEEPER, adjustment([take("60")]));
    const outcomes = await Promise.allSettled([
      decideAdjustment(world.a.as.MANAGER, { adjustmentId: one.id, outcome: "APPLIED" }),
      decideAdjustment(world.a.as.ADMIN, { adjustmentId: two.id, outcome: "APPLIED" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await inStoreroom()).toBe("40.000");
    expect((await listAdjustments(world.a.as.ADMIN)).waiting).toBe(1);
  });
});

describe("adjusting from a count", () => {
  it("proposes −5 for a count of 95, demands a reason, and a manager's applies at once", async () => {
    const counted = await countedNinetyFive(world.a.as.MANAGER);
    const before = await everything();
    expect((await refusal(adjustFromCount(world.a.as.MANAGER, { requestId: randomUUID(), countId: counted.id, reasons: [] }))).fieldErrors).toEqual({ "lines.1.reason": "Choose a reason." });
    expect((await refusal(adjustFromCount(world.a.as.MANAGER, { requestId: randomUUID(), countId: counted.id, reasons: [{ lineNumber: 1, reason: "OTHER" }] }))).fieldErrors).toHaveProperty("note");
    expect(await everything()).toBe(before);

    const saved = await adjustFromCount(world.a.as.MANAGER, { requestId: randomUUID(), countId: counted.id, reasons: [{ lineNumber: 1, reason: "MISSING" }] });
    expect(saved.status).toBe("APPLIED");
    expect(await inStoreroom()).toBe("95.000");

    const detail = await getAdjustment(world.a.as.ADMIN, { adjustmentId: saved.id });
    expect(detail.count).toEqual({ id: counted.id, number: 1 });
    expect(detail.lines.map((line) => [line.quantity, line.unitName, line.reason])).toEqual([["-5.000", "single", "MISSING"]]);
    expect(await getCount(world.a.as.ADMIN, { countId: counted.id })).toMatchObject({ canAdjust: false, adjustment: { id: saved.id, number: 1, status: "APPLIED" } });
  });

  it("takes the amounts from the saved count, never from the browser", async () => {
    const counted = await countedNinetyFive(world.a.as.ADMIN);
    await adjustFromCount(world.a.as.ADMIN, {
      requestId: randomUUID(),
      countId: counted.id,
      reasons: [{ lineNumber: 1, reason: "DAMAGED" }],
      // Anything else sent along is ignored.
      lines: [{ productId: sachet(), quantity: "-90" }],
      difference: "-90",
    } as Record<string, unknown>);
    expect(await inStoreroom()).toBe("95.000");
  });

  it("does not wipe out what happened between counting and applying: 10 more leave, then −5 is applied, giving 85 — not 95", async () => {
    const counted = await countedNinetyFive();
    const requested = await adjustFromCount(world.a.as.STOREKEEPER, { requestId: randomUUID(), countId: counted.id, reasons: [{ lineNumber: 1, reason: "MISSING" }] });
    expect(requested.status).toBe("PENDING");
    expect(await getCount(world.a.as.STOREKEEPER, { countId: counted.id })).toMatchObject({ adjustment: { status: "PENDING" }, canAdjust: false });

    await tenLeaveTheStoreroom();
    expect(await inStoreroom()).toBe("90.000");

    await decideAdjustment(world.a.as.MANAGER, { adjustmentId: requested.id, outcome: "APPLIED" });
    expect(await inStoreroom()).toBe("85.000");
    const total = await getDb().stockBalance.aggregate({ where: { productId: sachet() }, _sum: { quantity: true } });
    expect(total._sum.quantity?.toFixed(3)).toBe("95.000");
  });

  it("adds stock when more was counted than expected, and handles several products with their own reasons", async () => {
    const { id: sprayerId } = await createProduct(world.a.as.ADMIN, { name: "Hand Sprayer", code: "", barcode: "", baseUnitName: "piece", allowsFraction: false, taxable: true, tracksBatch: false, tracksExpiry: false, baseForSale: true, basePrice: "5000" });
    const piece = await getDb().productUnit.findFirstOrThrow({ where: { productId: sprayerId, isBase: true } });
    await receiveGoods(world.a.as.ADMIN, { requestId: randomUUID(), supplierId: world.a.supplierId, locationId: world.a.storeroomId, lines: [{ productId: sprayerId, unitId: piece.id, quantity: "4", unitCost: "3000" }] });

    const counted = await submitCount(world.a.as.ADMIN, {
      requestId: randomUUID(),
      locationId: world.a.storeroomId,
      lines: [
        { productId: sprayerId, entries: [{ unitId: piece.id, quantity: "3" }] },
        { productId: sachet(), entries: [{ unitId: cartonId, quantity: "1" }, { unitId: single(), quantity: "2" }] },
      ],
    });
    await adjustFromCount(world.a.as.ADMIN, {
      requestId: randomUUID(),
      countId: counted.id,
      reasons: [
        { lineNumber: 1, reason: "DAMAGED" },
        { lineNumber: 2, reason: "FOUND" },
      ],
    });
    expect(await inStoreroom(sprayerId)).toBe("3.000");
    expect(await inStoreroom()).toBe("102.000");
    const lines = await getDb().stockAdjustmentLine.findMany({ orderBy: { lineNumber: "asc" } });
    expect(lines.map((line) => [line.productName, line.baseQuantity.toFixed(3), line.reason])).toEqual([
      ["Hand Sprayer", "-1.000", "DAMAGED"],
      ["A Seed Sachet", "2.000", "FOUND"],
    ]);
  });

  it("allows one adjustment per count, however it is asked for", async () => {
    const counted = await countedNinetyFive(world.a.as.ADMIN);
    const reasons = [{ lineNumber: 1, reason: "MISSING" }];
    const request = { requestId: randomUUID(), countId: counted.id, reasons };

    const first = await adjustFromCount(world.a.as.ADMIN, request);
    expect(await adjustFromCount(world.a.as.ADMIN, request)).toEqual({ ...first, alreadySaved: true });
    expect((await refusal(adjustFromCount(world.a.as.MANAGER, { ...request, requestId: randomUUID() }))).message).toContain("AD-000001 has already been recorded for this count");
    expect(await inStoreroom()).toBe("95.000");

    // Two different people, same instant, another count.
    const again = await submitCount(world.a.as.ADMIN, count([{ unitId: single(), quantity: "90" }]));
    const outcomes = await Promise.allSettled([
      adjustFromCount(world.a.as.ADMIN, { requestId: randomUUID(), countId: again.id, reasons }),
      adjustFromCount(world.a.as.MANAGER, { requestId: randomUUID(), countId: again.id, reasons }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await inStoreroom()).toBe("90.000");
    expect(await getDb().stockAdjustment.count()).toBe(2);
  });
});

describe("who may do what, and business separation", () => {
  it("lets admin, manager and storekeeper count and adjust; only admin, manager and owner approve; cashier and accountant do neither", async () => {
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      await expect(submitCount(world.a.as[role], count([{ unitId: single(), quantity: "1" }]))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getCountSheet(world.a.as[role])).rejects.toBeInstanceOf(ForbiddenError);
      await expect(recordAdjustment(world.a.as[role], adjustment([take("1")]))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getAdjustmentOptions(world.a.as[role])).rejects.toBeInstanceOf(ForbiddenError);
    }
    const pending = await recordAdjustment(world.a.as.STOREKEEPER, adjustment([take("1")]));
    for (const role of ["STOREKEEPER", "CASHIER", "ACCOUNTANT"] as const) {
      await expect(decideAdjustment(world.a.as[role], { adjustmentId: pending.id, outcome: "APPLIED" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await inStoreroom()).toBe("100.000");
    await decideAdjustment(world.ownerInA, { adjustmentId: pending.id, outcome: "APPLIED" });
    expect(await inStoreroom()).toBe("99.000");

    expect((await getAdjustmentOptions(world.a.as.STOREKEEPER)).appliesAtOnce).toBe(false);
    const options = await getAdjustmentOptions(world.a.as.MANAGER);
    expect(options.appliesAtOnce).toBe(true);
    expect(options.products[0].stock).toEqual({ [world.a.storeroomId]: "99.000" });

    // The accountant can read counts and adjustments; the cashier cannot.
    expect((await listAdjustments(world.a.as.ACCOUNTANT)).adjustments).toHaveLength(1);
    await expect(listAdjustments(world.a.as.CASHIER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listCounts(world.a.as.CASHIER)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("keeps businesses apart", async () => {
    const counted = await countedNinetyFive();
    const pending = await recordAdjustment(world.a.as.STOREKEEPER, adjustment([take("5")]));

    await expect(getCount(world.b.as.ADMIN, { countId: counted.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getAdjustment(world.b.as.ADMIN, { adjustmentId: pending.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(decideAdjustment(world.b.as.ADMIN, { adjustmentId: pending.id, outcome: "APPLIED" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(adjustFromCount(world.b.as.ADMIN, { requestId: randomUUID(), countId: counted.id, reasons: [{ lineNumber: 1, reason: "MISSING" }] })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listCounts(world.b.as.ADMIN)).counts).toEqual([]);
    expect((await listAdjustments(world.b.as.ADMIN)).adjustments).toEqual([]);
    expect((await listAdjustments(world.b.as.ADMIN)).waiting).toBe(0);
    expect(await inStoreroom()).toBe("100.000");
    expect(await getDb().stockBalance.count({ where: { businessId: world.b.id } })).toBe(0);
  });
});

describe("the adjustments list and its history", () => {
  it("filters by status, finds by product, person and number, and cannot be altered in the database", async () => {
    const applied = await recordAdjustment(world.a.as.ADMIN, adjustment([take("1")]));
    const waiting = await recordAdjustment(world.a.as.STOREKEEPER, adjustment([take("2")]));
    const rejected = await recordAdjustment(world.a.as.STOREKEEPER, adjustment([take("3")]));
    await decideAdjustment(world.a.as.ADMIN, { adjustmentId: rejected.id, outcome: "REJECTED", note: "Not agreed" });

    const numbers = async (filter: Record<string, string>) => (await listAdjustments(world.a.as.ADMIN, filter)).adjustments.map((row) => row.number);
    expect(await numbers({})).toEqual([3, 2, 1]);
    expect(await numbers({ status: "pending" })).toEqual([2]);
    expect(await numbers({ status: "applied" })).toEqual([1]);
    expect(await numbers({ status: "rejected" })).toEqual([3]);
    expect(await numbers({ search: "storekeeper" })).toEqual([3, 2]);
    expect(await numbers({ search: "AD-000001" })).toEqual([1]);
    expect(await numbers({ search: "seed sachet" })).toEqual([3, 2, 1]);
    expect(await numbers({ to: "2020-01-01" })).toEqual([]);
    const list = await listAdjustments(world.a.as.STOREKEEPER);
    expect(list).toMatchObject({ waiting: 1, canRecord: true, canDecide: false });
    expect(list.adjustments[0]).toMatchObject({ status: "REJECTED", decidedByName: "Test a.admin", products: ["A Seed Sachet"] });

    const db = getDb();
    const line = await db.stockAdjustmentLine.findFirstOrThrow({ where: { adjustmentId: applied.id } });
    const decision = await db.stockAdjustmentDecision.findFirstOrThrow({ where: { adjustmentId: applied.id } });
    await expect(db.stockAdjustment.update({ where: { id: applied.id }, data: { note: "x" } })).rejects.toThrow();
    await expect(db.stockAdjustment.delete({ where: { id: waiting.id } })).rejects.toThrow();
    await expect(db.stockAdjustmentLine.update({ where: { id: line.id }, data: { reason: "FOUND" } })).rejects.toThrow();
    await expect(db.stockAdjustmentLine.delete({ where: { id: line.id } })).rejects.toThrow();
    await expect(db.stockAdjustmentDecision.update({ where: { id: decision.id }, data: { outcome: "REJECTED", note: "changed my mind" } })).rejects.toThrow();
    await expect(db.stockAdjustmentDecision.delete({ where: { id: decision.id } })).rejects.toThrow();
    // A second decision, a rejection without a note, and a zero line cannot exist.
    await expect(db.stockAdjustmentDecision.create({ data: { businessId: world.a.id, adjustmentId: applied.id, outcome: "APPLIED", decidedByName: "x" } })).rejects.toThrow();
    await expect(db.stockAdjustmentDecision.create({ data: { businessId: world.a.id, adjustmentId: waiting.id, outcome: "REJECTED", decidedByName: "x" } })).rejects.toThrow();
    await expect(db.stockAdjustmentLine.create({ data: { ...line, id: randomUUID(), lineNumber: 9, quantity: "0", baseQuantity: "0" } })).rejects.toThrow();
  });
});
