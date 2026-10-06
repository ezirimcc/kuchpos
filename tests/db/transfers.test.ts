import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUnit, createProduct, retireUnit, setProductActive } from "@/server/business/catalog";
import { listStockOnHand, receiveGoods } from "@/server/business/stock";
import { getTransfer, getTransferOptions, listTransfers, transferStock } from "@/server/business/transfers";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, type World } from "../support/world";

/** Moving stock between the Storeroom and the Shelf. */

let world: World;
let cartonId = "";

beforeEach(async () => {
  world = await createWorld();
  // single = 1, pack = 10 (from the fixtures) and carton = 100; two cartons in the Storeroom.
  cartonId = (
    await addUnit(world.a.as.ADMIN, { productId: world.a.product.id, name: "carton", factor: "100", forSale: true, forPurchase: true, price: "8500" })
  ).id;
  await receiveGoods(world.a.as.ADMIN, {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.storeroomId,
    lines: [{ productId: world.a.product.id, unitId: cartonId, quantity: "2", unitCost: "5000" }],
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

type Line = { productId: string; unitId: string; quantity: string };

function toShelf(lines: Line[], extra: Record<string, unknown> = {}) {
  return { requestId: randomUUID(), fromLocationId: world.a.storeroomId, toLocationId: world.a.shelfId, lines, ...extra };
}

const sachets = (unitId: string, quantity: string): Line => ({ productId: world.a.product.id, unitId, quantity });

async function quantityAt(productId: string, locationId: string): Promise<string> {
  const balance = await getDb().stockBalance.findUnique({ where: { productId_locationId: { productId, locationId } } });
  return balance ? balance.quantity.toFixed(3) : "0.000";
}

async function totalOf(productId: string): Promise<string> {
  const sum = await getDb().stockBalance.aggregate({ where: { productId }, _sum: { quantity: true } });
  return sum._sum.quantity?.toFixed(3) ?? "0.000";
}

/** A weighed product with 80 kg in the Storeroom. */
async function fertilizer() {
  const { id } = await createProduct(world.a.as.ADMIN, {
    name: "NPK Fertilizer",
    code: "",
    barcode: "",
    baseUnitName: "kg",
    allowsFraction: true,
    taxable: true,
    tracksBatch: false,
    tracksExpiry: false,
    baseForSale: true,
    basePrice: "1250.50",
  });
  const kg = await getDb().productUnit.findFirstOrThrow({ where: { productId: id, isBase: true } });
  await receiveGoods(world.a.as.ADMIN, {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.storeroomId,
    lines: [{ productId: id, unitId: kg.id, quantity: "80", unitCost: "400" }],
  });
  return { productId: id, kgId: kg.id };
}

async function everything() {
  const db = getDb();
  return JSON.stringify({
    transfers: await db.stockTransfer.count(),
    lines: await db.stockTransferLine.count(),
    movements: await db.stockMovement.findMany({ orderBy: { id: "asc" } }),
    balances: await db.stockBalance.findMany({ orderBy: { id: "asc" } }),
    counter: (await db.business.findUniqueOrThrow({ where: { id: world.a.id } })).nextStockTransferNumber,
    activity: await db.activityLog.count(),
  });
}

describe("moving stock", () => {
  it("moves 1 carton to the Shelf: Storeroom 100, Shelf 100, and the total is unchanged", async () => {
    const saved = await transferStock(world.a.as.STOREKEEPER, toShelf([sachets(cartonId, "1")]));
    expect(saved).toMatchObject({ number: 1, alreadySaved: false });

    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("100.000");
    expect(await quantityAt(world.a.product.id, world.a.shelfId)).toBe("100.000");
    expect(await totalOf(world.a.product.id)).toBe("200.000");
  });

  it("writes one movement out and one in for every line, with the unit as chosen, and leaves the average cost alone", async () => {
    const { id } = await transferStock(world.a.as.MANAGER, toShelf([sachets(cartonId, "1"), sachets(world.a.product.packUnitId, "3")]));

    const movements = await getDb().stockMovement.findMany({ where: { documentId: id }, orderBy: [{ unitName: "asc" }, { type: "asc" }] });
    expect(
      movements.map((movement) => [movement.type, movement.locationId, movement.quantityDelta.toFixed(3), movement.unitName, movement.unitQuantity.toFixed(3), movement.documentNumber]),
    ).toEqual([
      ["TRANSFER_OUT", world.a.storeroomId, "-100.000", "carton", "-1.000", "TR-000001"],
      ["TRANSFER_IN", world.a.shelfId, "100.000", "carton", "1.000", "TR-000001"],
      ["TRANSFER_OUT", world.a.storeroomId, "-30.000", "pack", "-3.000", "TR-000001"],
      ["TRANSFER_IN", world.a.shelfId, "30.000", "pack", "3.000", "TR-000001"],
    ]);
    expect(movements.every((movement) => movement.userName === "Test a.manager")).toBe(true);
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("70.000");
    expect(await quantityAt(world.a.product.id, world.a.shelfId)).toBe("130.000");
    expect((await getDb().product.findUniqueOrThrow({ where: { id: world.a.product.id } })).averageCost.toFixed(4)).toBe("50.0000");
  });

  it("moves stock back the other way, and can empty a location exactly", async () => {
    await transferStock(world.a.as.ADMIN, toShelf([sachets(cartonId, "2")]));
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("0.000");

    await transferStock(world.a.as.ADMIN, {
      requestId: randomUUID(),
      fromLocationId: world.a.shelfId,
      toLocationId: world.a.storeroomId,
      lines: [sachets(world.a.product.baseUnitId, "45")],
    });
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("45.000");
    expect(await quantityAt(world.a.product.id, world.a.shelfId)).toBe("155.000");
    expect(await totalOf(world.a.product.id)).toBe("200.000");
  });

  it("moves part of a bag of a weighed product (12.5 kg), but only whole units of a whole-unit product", async () => {
    const npk = await fertilizer();
    await transferStock(world.a.as.ADMIN, toShelf([{ productId: npk.productId, unitId: npk.kgId, quantity: "12.5" }]));
    expect(await quantityAt(npk.productId, world.a.shelfId)).toBe("12.500");
    expect(await quantityAt(npk.productId, world.a.storeroomId)).toBe("67.500");

    const errors = (await refusal(transferStock(world.a.as.ADMIN, toShelf([sachets(world.a.product.packUnitId, "1.5")])))).fieldErrors;
    expect(errors["lines.0.quantity"]).toMatch(/whole units only/);
  });

  it("numbers transfers 1, 2, 3… separately for each business, and writes the activity log", async () => {
    const first = await transferStock(world.a.as.ADMIN, toShelf([sachets(world.a.product.baseUnitId, "1")]));
    const second = await transferStock(world.a.as.ADMIN, toShelf([sachets(world.a.product.baseUnitId, "1")]));
    expect([first.number, second.number]).toEqual([1, 2]);
    expect((await getDb().business.findUniqueOrThrow({ where: { id: world.b.id } })).nextStockTransferNumber).toBe(1);

    const log = await getDb().activityLog.findMany({ where: { action: "stock.transferred" }, orderBy: { createdAt: "asc" } });
    expect(log).toHaveLength(2);
    expect(log[0].summary).toBe("Test a.admin moved stock from Storeroom to Shelf (transfer TR-000001): 1 single of A Seed Sachet.");
  });
});

describe("transfers that are refused, with nothing moved", () => {
  it("refuses more than is in the location, says how much is there, and saves nothing", async () => {
    const before = await everything();
    const error = await refusal(transferStock(world.a.as.ADMIN, toShelf([sachets(cartonId, "3")])));
    expect(error.message).toBe("Nothing was moved: there is not enough in Storeroom.");
    expect(error.fieldErrors["lines.0.quantity"]).toBe('Only 200 single of "A Seed Sachet" is in Storeroom. You asked to move 300 single.');
    expect(await everything()).toBe(before);
  });

  it("adds up several lines of one product before deciding there is enough", async () => {
    const before = await everything();
    const errors = (await refusal(transferStock(world.a.as.ADMIN, toShelf([sachets(cartonId, "1"), sachets(world.a.product.packUnitId, "11")])))).fieldErrors;
    expect(Object.keys(errors).sort()).toEqual(["lines.0.quantity", "lines.1.quantity"]);
    expect(errors["lines.1.quantity"]).toContain("You asked to move 210 single");
    expect(await everything()).toBe(before);
  });

  it("moves nothing at all when one product of several is short", async () => {
    const npk = await fertilizer();
    const before = await everything();
    const errors = (
      await refusal(transferStock(world.a.as.ADMIN, toShelf([sachets(cartonId, "1"), { productId: npk.productId, unitId: npk.kgId, quantity: "80.001" }])))
    ).fieldErrors;
    expect(Object.keys(errors)).toEqual(["lines.1.quantity"]);
    expect(await everything()).toBe(before);
    expect(await quantityAt(world.a.product.id, world.a.shelfId)).toBe("0.000");
  });

  it("refuses to move from a location that holds none of the product", async () => {
    const error = await refusal(
      transferStock(world.a.as.ADMIN, { requestId: randomUUID(), fromLocationId: world.a.shelfId, toLocationId: world.a.storeroomId, lines: [sachets(cartonId, "1")] }),
    );
    expect(error.fieldErrors["lines.0.quantity"]).toContain("Only 0 single");
  });

  it("refuses the same location twice, no lines, bad amounts, and units or products that are out of use", async () => {
    const before = await everything();
    const attempt = async (input: Record<string, unknown>) => (await refusal(transferStock(world.a.as.ADMIN, input))).fieldErrors;

    expect(await attempt(toShelf([sachets(cartonId, "1")], { toLocationId: world.a.storeroomId }))).toHaveProperty("toLocationId");
    expect(await attempt(toShelf([sachets(cartonId, "1")], { fromLocationId: randomUUID() }))).toHaveProperty("fromLocationId");
    expect(await attempt(toShelf([]))).toHaveProperty("lines");
    expect(await attempt(toShelf([sachets(cartonId, "1")], { requestId: "nope" }))).toHaveProperty("requestId");
    for (const quantity of ["0", "-1", "one", "1,5", "1.2345", ""]) {
      expect(await attempt(toShelf([sachets(cartonId, quantity)])), quantity).toHaveProperty(["lines.0.quantity"]);
    }
    expect(await attempt(toShelf([{ productId: randomUUID(), unitId: cartonId, quantity: "1" }]))).toHaveProperty(["lines.0.productId"]);
    expect(await attempt(toShelf([sachets(randomUUID(), "1")]))).toHaveProperty(["lines.0.unitId"]);

    expect(await everything()).toBe(before);

    await retireUnit(world.a.as.ADMIN, { unitId: cartonId });
    expect(await attempt(toShelf([sachets(cartonId, "1")]))).toHaveProperty(["lines.0.unitId"]);
    await setProductActive(world.a.as.ADMIN, { productId: world.a.product.id, active: false });
    expect(await attempt(toShelf([sachets(world.a.product.packUnitId, "1")]))).toHaveProperty(["lines.0.productId"]);
    expect(await getDb().stockTransfer.count()).toBe(0);
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("200.000");
  });
});

describe("several people at once, and repeated submissions", () => {
  it("saves a transfer once when the same request is sent again, or twice at the same instant", async () => {
    const request = toShelf([sachets(cartonId, "1")]);
    const first = await transferStock(world.a.as.ADMIN, request);
    const again = await transferStock(world.a.as.ADMIN, request);
    expect(again).toEqual({ ...first, alreadySaved: true });

    const other = toShelf([sachets(world.a.product.packUnitId, "1")]);
    const results = await Promise.all([transferStock(world.a.as.ADMIN, other), transferStock(world.a.as.ADMIN, other)]);
    expect(results.filter((result) => !result.alreadySaved)).toHaveLength(1);

    expect(await getDb().stockTransfer.count()).toBe(2);
    expect(await quantityAt(world.a.product.id, world.a.shelfId)).toBe("110.000");
  });

  it("lets exactly one through when two transfers at the same instant together ask for more than there is", async () => {
    const outcomes = await Promise.allSettled([
      transferStock(world.a.as.STOREKEEPER, toShelf([sachets(world.a.product.baseUnitId, "150")])),
      transferStock(world.a.as.MANAGER, toShelf([sachets(world.a.product.baseUnitId, "150")])),
    ]);
    const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ValidationError);
    expect(refused[0].reason.fieldErrors["lines.0.quantity"]).toContain("Only 50 single");

    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("50.000");
    expect(await quantityAt(world.a.product.id, world.a.shelfId)).toBe("150.000");
    expect(await getDb().stockTransfer.count()).toBe(1);
  });

  it("keeps the total exact through many transfers both ways and a delivery, all at the same instant", async () => {
    await transferStock(world.a.as.ADMIN, toShelf([sachets(cartonId, "1")]));
    const back = (quantity: string) => ({
      requestId: randomUUID(),
      fromLocationId: world.a.shelfId,
      toLocationId: world.a.storeroomId,
      lines: [sachets(world.a.product.baseUnitId, quantity)],
    });
    await Promise.all([
      transferStock(world.a.as.ADMIN, toShelf([sachets(world.a.product.baseUnitId, "10")])),
      transferStock(world.a.as.MANAGER, toShelf([sachets(world.a.product.baseUnitId, "20")])),
      transferStock(world.a.as.STOREKEEPER, back("5")),
      transferStock(world.a.as.ADMIN, back("7")),
      receiveGoods(world.a.as.ADMIN, {
        requestId: randomUUID(),
        supplierId: world.a.supplierId,
        locationId: world.a.storeroomId,
        lines: [{ productId: world.a.product.id, unitId: cartonId, quantity: "1", unitCost: "5000" }],
      }),
    ]);
    // Storeroom 100 − 10 − 20 + 5 + 7 + 100; Shelf 100 + 10 + 20 − 5 − 7.
    expect(await quantityAt(world.a.product.id, world.a.storeroomId)).toBe("182.000");
    expect(await quantityAt(world.a.product.id, world.a.shelfId)).toBe("118.000");
    expect(await totalOf(world.a.product.id)).toBe("300.000");
    expect((await getDb().product.findUniqueOrThrow({ where: { id: world.a.product.id } })).averageCost.toFixed(4)).toBe("50.0000");
  });
});

describe("who may transfer, and business separation", () => {
  it("lets admin, manager, storekeeper and owner; refuses the cashier and the accountant", async () => {
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      await expect(transferStock(world.a.as[role], toShelf([sachets(cartonId, "1")]))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getTransferOptions(world.a.as[role])).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const context of [world.a.as.ADMIN, world.a.as.MANAGER, world.a.as.STOREKEEPER, world.ownerInA]) {
      await transferStock(context, toShelf([sachets(world.a.product.baseUnitId, "1")]));
    }
    expect(await quantityAt(world.a.product.id, world.a.shelfId)).toBe("4.000");

    // The accountant can read the paper trail; the cashier cannot.
    expect((await listTransfers(world.a.as.ACCOUNTANT)).transfers).toHaveLength(4);
    await expect(listTransfers(world.a.as.CASHIER)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cannot use business B's locations, products or units, and B sees nothing of A's transfers", async () => {
    const before = await everything();
    const attempt = async (input: Record<string, unknown>) => Object.keys((await refusal(transferStock(world.a.as.ADMIN, input))).fieldErrors);

    expect(await attempt(toShelf([sachets(cartonId, "1")], { toLocationId: world.b.shelfId }))).toEqual(["toLocationId"]);
    expect(await attempt(toShelf([sachets(cartonId, "1")], { fromLocationId: world.b.storeroomId }))).toEqual(["fromLocationId"]);
    expect(await attempt(toShelf([{ productId: world.b.product.id, unitId: world.b.product.packUnitId, quantity: "1" }]))).toEqual(["lines.0.productId"]);
    expect(await attempt(toShelf([sachets(world.b.product.packUnitId, "1")]))).toEqual(["lines.0.unitId"]);
    expect(await everything()).toBe(before);

    const { id } = await transferStock(world.a.as.ADMIN, toShelf([sachets(cartonId, "1")]));
    expect((await listTransfers(world.b.as.ADMIN)).transfers).toEqual([]);
    await expect(getTransfer(world.b.as.ADMIN, { transferId: id })).rejects.toBeInstanceOf(NotFoundError);
    expect((await getTransferOptions(world.b.as.ADMIN)).products).toEqual([]);
    expect(await getDb().stockBalance.count({ where: { businessId: world.b.id } })).toBe(0);
  });
});

describe("the paper trail", () => {
  it("keeps the product name, unit and conversion as they were, and cannot be altered even in the database", async () => {
    const { id } = await transferStock(world.a.as.ADMIN, toShelf([sachets(cartonId, "1")], { note: "Restocking the front" }));
    await retireUnit(world.a.as.ADMIN, { unitId: cartonId });
    await addUnit(world.a.as.ADMIN, { productId: world.a.product.id, name: "carton", factor: "96", forSale: true, forPurchase: true, price: "8500" });

    const transfer = await getTransfer(world.a.as.ACCOUNTANT, { transferId: id });
    expect(transfer).toMatchObject({ number: 1, fromLocationName: "Storeroom", toLocationName: "Shelf", note: "Restocking the front", createdByName: "Test a.admin", lineCount: 1 });
    expect(transfer.lines).toEqual([
      { lineNumber: 1, productId: world.a.product.id, productName: "A Seed Sachet", unitName: "carton", unitFactor: "100.000", quantity: "1.000", baseQuantity: "100.000" },
    ]);

    const db = getDb();
    const line = await db.stockTransferLine.findFirstOrThrow({ where: { transferId: id } });
    await expect(db.stockTransfer.update({ where: { id }, data: { note: "changed" } })).rejects.toThrow();
    await expect(db.stockTransfer.delete({ where: { id } })).rejects.toThrow();
    await expect(db.stockTransferLine.update({ where: { id: line.id }, data: { quantity: "9" } })).rejects.toThrow();
    await expect(db.stockTransferLine.delete({ where: { id: line.id } })).rejects.toThrow();
    // A transfer from a location to itself cannot exist.
    await expect(
      db.stockTransfer.create({
        data: { businessId: world.a.id, requestId: randomUUID(), number: 99, fromLocationId: world.a.shelfId, fromLocationName: "Shelf", toLocationId: world.a.shelfId, toLocationName: "Shelf", createdByName: "x" },
      }),
    ).rejects.toThrow();
  });

  it("lists transfers newest first and finds them by product, person, number or day", async () => {
    const npk = await fertilizer();
    await transferStock(world.a.as.ADMIN, toShelf([sachets(cartonId, "1")]));
    await transferStock(world.a.as.STOREKEEPER, toShelf([{ productId: npk.productId, unitId: npk.kgId, quantity: "5" }, sachets(world.a.product.packUnitId, "1")]));

    const all = await listTransfers(world.a.as.ADMIN);
    expect(all.canTransfer).toBe(true);
    expect(all.transfers.map((transfer) => [transfer.number, transfer.lineCount, transfer.products])).toEqual([
      [2, 2, ["NPK Fertilizer", "A Seed Sachet"]],
      [1, 1, ["A Seed Sachet"]],
    ]);
    const find = async (search: string) => (await listTransfers(world.a.as.ADMIN, { search })).transfers.map((transfer) => transfer.number);
    expect(await find("npk")).toEqual([2]);
    expect(await find("storekeeper")).toEqual([2]);
    expect(await find("TR-000001")).toEqual([1]);
    expect(await find("nothing like this")).toEqual([]);
    expect((await listTransfers(world.a.as.ADMIN, { to: "2020-01-01" })).transfers).toEqual([]);
    expect((await listTransfers(world.a.as.ACCOUNTANT)).canTransfer).toBe(false);
  });

  it("offers only products with stock, shows how much is where, and stock on hand follows a transfer", async () => {
    await createProduct(world.a.as.ADMIN, { name: "Never Stocked", code: "", barcode: "", baseUnitName: "piece", allowsFraction: false, taxable: true, tracksBatch: false, tracksExpiry: false, baseForSale: true, basePrice: "10" });
    await transferStock(world.a.as.ADMIN, toShelf([sachets(world.a.product.packUnitId, "4")]));

    const options = await getTransferOptions(world.a.as.STOREKEEPER);
    expect(options.locations.map((location) => location.name)).toEqual(["Storeroom", "Shelf"]);
    expect(options.products.map((product) => product.name)).toEqual(["A Seed Sachet"]);
    expect(options.products[0].stock).toEqual({ [world.a.storeroomId]: "160.000", [world.a.shelfId]: "40.000" });
    expect(options.products[0].units.map((unit) => unit.name)).toEqual(["single", "pack", "carton"]);

    const row = (await listStockOnHand(world.a.as.CASHIER)).rows.find((candidate) => candidate.productId === world.a.product.id)!;
    expect(row.byLocation).toEqual({ [world.a.storeroomId]: "160.000", [world.a.shelfId]: "40.000" });
    expect(row.total).toBe("200.000");
  });
});
