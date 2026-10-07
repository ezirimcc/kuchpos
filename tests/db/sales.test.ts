import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addUnit, createProduct, retireUnit, setProductActive, setUnitPrice } from "@/server/business/catalog";
import { getCheckoutCatalogue, getSale, listSales, postSale, recordReceiptPrint } from "@/server/business/sales";
import { setTaxRate } from "@/server/business/settings";
import { createTerminal, setTerminalActive } from "@/server/business/setup";
import { receiveGoods } from "@/server/business/stock";
import { openTill } from "@/server/business/till";
import { transferStock } from "@/server/business/transfers";
import { recordAdjustment } from "@/server/business/adjustments";
import type { AppContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, type World } from "../support/world";

/** Checkout: a cash sale is saved whole or not at all, once, at the server's own prices. */

let world: World;
let cartonId = "";

async function deliver(business: World["a"], locationId: string, lines: { productId: string; unitId: string; quantity: string; unitCost: string }[]) {
  await receiveGoods(business.as.ADMIN, { requestId: randomUUID(), supplierId: business.supplierId, locationId, lines });
}

beforeEach(async () => {
  await getDb().$executeRawUnsafe("DROP TRIGGER IF EXISTS `payment_test_failure`");
  world = await createWorld();
  // single ₦100, pack of 10 ₦900 (from the fixtures) and carton of 100 ₦8,500.
  // 2 cartons on the Shelf and 1 in the Storeroom, all bought at ₦50 a single.
  cartonId = (
    await addUnit(world.a.as.ADMIN, { productId: world.a.product.id, name: "carton", factor: "100", forSale: true, forPurchase: true, price: "8500" })
  ).id;
  await deliver(world.a, world.a.shelfId, [{ productId: world.a.product.id, unitId: cartonId, quantity: "2", unitCost: "5000" }]);
  await deliver(world.a, world.a.storeroomId, [{ productId: world.a.product.id, unitId: cartonId, quantity: "1", unitCost: "5000" }]);
  // Selling needs an open till at the terminal.
  await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "0" });
  await openTill(world.b.as.CASHIER, { terminalId: world.b.terminalId, openingFloat: "0" });
});

// The golden rule, checked after every single test in this file.
afterEach(async () => {
  await getDb().$executeRawUnsafe("DROP TRIGGER IF EXISTS `payment_test_failure`");
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

type Line = { productId: string; unitId: string; quantity: string; unitPrice: string; fromStoreroom?: boolean };
const singles = (quantity: string): Line => ({ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity, unitPrice: "100.00" });
const packs = (quantity: string): Line => ({ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity, unitPrice: "900.00" });
const cartons = (quantity: string): Line => ({ productId: world.a.product.id, unitId: cartonId, quantity, unitPrice: "8500.00" });

/** A sale paid in cash: `tendered` is what the customer hands over. */
function sale(lines: Line[], expectedTotal: string, tendered = expectedTotal, extra: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    expectedTotal,
    payments: [{ methodId: world.a.cashMethodId, amount: expectedTotal, tendered }],
    lines,
    ...extra,
  };
}

/** The same for business B: one single at ₦100, paid exactly, in cash. */
function saleInB() {
  return {
    requestId: randomUUID(),
    terminalId: world.b.terminalId,
    expectedTotal: "100.00",
    payments: [{ methodId: world.b.cashMethodId, amount: "100.00" }],
    lines: [{ productId: world.b.product.id, unitId: world.b.product.baseUnitId, quantity: "1", unitPrice: "100.00" }],
  };
}

/** A second checkout terminal in business A, with its till open. */
async function secondTill(paperWidth: "MM58" | "MM80" = "MM80") {
  const terminal = await createTerminal(world.a.as.ADMIN, { code: "T2", name: "Second till", paperWidth });
  await openTill(world.a.as.MANAGER, { terminalId: terminal.id, openingFloat: "0" });
  return terminal;
}

async function held(locationId: string, productId = world.a.product.id): Promise<string> {
  const balance = await getDb().stockBalance.findUnique({ where: { productId_locationId: { productId, locationId } } });
  return balance ? balance.quantity.toFixed(3) : "0.000";
}
const onShelf = (productId?: string) => held(world.a.shelfId, productId);

/** A product sold by weight at ₦1,250.50 a kg, with 20 kg on the Shelf bought at ₦400. */
async function weighed(options: { price?: string; taxable?: boolean; name?: string } = {}) {
  const { id } = await createProduct(world.a.as.ADMIN, {
    name: options.name ?? "NPK Fertilizer",
    code: "",
    barcode: "",
    baseUnitName: "kg",
    allowsFraction: true,
    taxable: options.taxable ?? true,
    tracksBatch: false,
    tracksExpiry: false,
    baseForSale: true,
    basePrice: options.price ?? "1250.50",
  });
  const kg = await getDb().productUnit.findFirstOrThrow({ where: { productId: id, isBase: true } });
  await deliver(world.a, world.a.shelfId, [{ productId: id, unitId: kg.id, quantity: "20", unitCost: "400" }]);
  return { productId: id, kgId: kg.id };
}

async function everything() {
  const db = getDb();
  return JSON.stringify({
    sales: await db.sale.count(),
    lines: await db.saleLine.count(),
    payments: await db.payment.count(),
    movements: await db.stockMovement.count(),
    balances: await db.stockBalance.findMany({ orderBy: { id: "asc" } }),
    terminals: await db.terminal.findMany({ orderBy: { id: "asc" }, select: { id: true, nextReceiptNumber: true } }),
    activity: await db.activityLog.count(),
  });
}

describe("a cash sale", () => {
  it("of 1 carton + 3 singles takes 103 singles off the Shelf and records both lines at their own prices", async () => {
    const result = await postSale(world.a.as.CASHIER, sale([cartons("1"), singles("3")], "8800.00", "10000"));
    expect(result).toMatchObject({ receiptNumber: "T1-000001", total: "8800.00", change: "1200.00", alreadySaved: false });

    expect(await onShelf()).toBe("97.000");
    expect(await held(world.a.storeroomId)).toBe("100.000");

    const detail = await getSale(world.a.as.CASHIER, { saleId: result.id });
    expect(detail).toMatchObject({ receiptNumber: "T1-000001", cashierName: "Test a.cashier", terminalCode: "T1", total: "8800.00", change: "1200.00", taxTotal: "0.00", printCount: 0 });
    expect(detail.payments).toEqual([{ methodName: "Cash", kind: "CASH", amount: "8800.00", tendered: "10000.00", change: "1200.00", reference: null }]);
    expect(detail.lines).toEqual([
      { lineNumber: 1, productName: "A Seed Sachet", unitName: "carton", quantity: "1.000", baseQuantity: "100.000", unitPrice: "8500.00", lineTotal: "8500.00", taxAmount: "0.00", locationName: "Shelf" },
      { lineNumber: 2, productName: "A Seed Sachet", unitName: "single", quantity: "3.000", baseQuantity: "3.000", unitPrice: "100.00", lineTotal: "300.00", taxAmount: "0.00", locationName: "Shelf" },
    ]);

    const movements = await getDb().stockMovement.findMany({ where: { documentId: result.id }, orderBy: { quantityDelta: "asc" } });
    expect(movements.map((movement) => [movement.type, movement.locationId, movement.quantityDelta.toFixed(3), movement.unitName, movement.documentNumber, movement.userName])).toEqual([
      ["SALE", world.a.shelfId, "-100.000", "carton", "T1-000001", "Test a.cashier"],
      ["SALE", world.a.shelfId, "-3.000", "single", "T1-000001", "Test a.cashier"],
    ]);
    const payments = await getDb().payment.findMany({ where: { saleId: result.id } });
    expect(payments.map((payment) => [payment.kind, payment.amount.toFixed(2), payment.tendered?.toFixed(2), payment.changeGiven?.toFixed(2), payment.receivedByName])).toEqual([
      ["CASH", "8800.00", "10000.00", "1200.00", "Test a.cashier"],
    ]);
  });

  it("works for 2.5 kg of a weighed product; 2.5 cartons of a whole-unit product is refused", async () => {
    const npk = await weighed();
    // 2.5 × 1,250.50 = 3,126.25
    const result = await postSale(world.a.as.CASHIER, sale([{ productId: npk.productId, unitId: npk.kgId, quantity: "2.5", unitPrice: "1250.50" }], "3126.25"));
    expect(result).toMatchObject({ total: "3126.25", change: "0.00" });
    expect(await onShelf(npk.productId)).toBe("17.500");

    const before = await everything();
    const errors = (await refusal(postSale(world.a.as.CASHIER, sale([cartons("2.5")], "21250.00")))).fieldErrors;
    expect(errors["lines.0.quantity"]).toMatch(/whole units only/);
    expect(await everything()).toBe(before);
  });

  it("rounds each line to the kobo and adds the rounded lines: 0.333 kg at ₦1,250.50 is ₦416.42", async () => {
    const npk = await weighed();
    const kg = (quantity: string) => ({ productId: npk.productId, unitId: npk.kgId, quantity, unitPrice: "1250.50" });
    // 0.333 × 1,250.50 = 416.4165 → 416.42, three times = 1,249.26 (not 0.999 × 1,250.50 = 1,249.25).
    const result = await postSale(world.a.as.CASHIER, sale([kg("0.333"), kg("0.333"), kg("0.333")], "1249.26"));
    expect(result.total).toBe("1249.26");
    expect(await onShelf(npk.productId)).toBe("19.001");
  });

  it("records what the goods cost at that moment, shown only to those who may see costs", async () => {
    const { id } = await postSale(world.a.as.CASHIER, sale([packs("2"), singles("5")], "2300.00"));
    const lines = await getDb().saleLine.findMany({ where: { saleId: id }, orderBy: { lineNumber: "asc" } });
    expect(lines.map((line) => [line.baseUnitCost.toFixed(4), line.lineCost.toFixed(2)])).toEqual([
      ["50.0000", "1000.00"],
      ["50.0000", "250.00"],
    ]);
    expect((await getSale(world.a.as.MANAGER, { saleId: id })).costTotal).toBe("1250.00");
    expect((await getSale(world.a.as.CASHIER, { saleId: id })).costTotal).toBeNull();
  });

  it("numbers receipts per terminal, without gaps, and separately in each business", async () => {
    const second = await secondTill("MM58");
    const numbers = [];
    numbers.push((await postSale(world.a.as.CASHIER, sale([singles("1")], "100.00"))).receiptNumber);
    numbers.push((await postSale(world.a.as.CASHIER, sale([singles("1")], "100.00", "100.00", { terminalId: second.id }))).receiptNumber);
    numbers.push((await postSale(world.a.as.MANAGER, sale([singles("1")], "100.00"))).receiptNumber);
    await refusal(postSale(world.a.as.CASHIER, sale([singles("1000")], "100000.00")));
    numbers.push((await postSale(world.a.as.CASHIER, sale([singles("1")], "100.00"))).receiptNumber);
    expect(numbers).toEqual(["T1-000001", "T2-000001", "T1-000002", "T1-000003"]);

    await deliver(world.b, world.b.shelfId, [{ productId: world.b.product.id, unitId: world.b.product.baseUnitId, quantity: "5", unitCost: "50" }]);
    const inB = await postSale(world.b.as.CASHIER, saleInB());
    expect(inB.receiptNumber).toBe("T1-000001");
    expect((await getSale(world.a.as.ADMIN, { saleId: (await listSales(world.a.as.ADMIN)).sales[2].id })).paperWidth).toBe("MM58");
  });
});

describe("tax inside the price", () => {
  it("at 7.5% records ₦75.00 tax on a taxable ₦1,075.00 line and ₦0.00 on a non-taxable one; the customer pays the shelf price", async () => {
    const taxed = await weighed({ name: "Taxed Feed", price: "1075", taxable: true });
    const untaxed = await weighed({ name: "Untaxed Grain", price: "1075", taxable: false });
    await setTaxRate(world.a.as.ADMIN, { ratePercent: "7.5" });

    const result = await postSale(
      world.a.as.CASHIER,
      sale(
        [
          { productId: taxed.productId, unitId: taxed.kgId, quantity: "1", unitPrice: "1075.00" },
          { productId: untaxed.productId, unitId: untaxed.kgId, quantity: "1", unitPrice: "1075.00" },
        ],
        "2150.00",
      ),
    );
    expect(result.total).toBe("2150.00");
    const detail = await getSale(world.a.as.ADMIN, { saleId: result.id });
    expect(detail).toMatchObject({ taxRatePercent: "7.50", taxTotal: "75.00", total: "2150.00" });
    expect(detail.lines.map((line) => [line.productName, line.lineTotal, line.taxAmount])).toEqual([
      ["Taxed Feed", "1075.00", "75.00"],
      ["Untaxed Grain", "1075.00", "0.00"],
    ]);
    const lines = await getDb().saleLine.findMany({ where: { saleId: result.id }, orderBy: { lineNumber: "asc" } });
    expect(lines.map((line) => [line.taxable, line.taxRatePercent.toFixed(2)])).toEqual([
      [true, "7.50"],
      [false, "0.00"],
    ]);
  });
});

describe("the sale keeps its own history", () => {
  it("still shows its original unit, conversion, price, tax and cost after all of them change", async () => {
    await setTaxRate(world.a.as.ADMIN, { ratePercent: "7.5" });
    const { id } = await postSale(world.a.as.CASHIER, sale([cartons("1")], "8500.00"));
    const before = JSON.stringify(await getSale(world.a.as.ADMIN, { saleId: id }));

    await retireUnit(world.a.as.ADMIN, { unitId: cartonId });
    await addUnit(world.a.as.ADMIN, { productId: world.a.product.id, name: "carton", factor: "96", forSale: true, forPurchase: true, price: "9900" });
    await setUnitPrice(world.a.as.ADMIN, { unitId: world.a.product.baseUnitId, price: "150" });
    await setTaxRate(world.a.as.ADMIN, { ratePercent: "10" });
    await deliver(world.a, world.a.shelfId, [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "100", unitCost: "90" }]);

    expect(JSON.stringify(await getSale(world.a.as.ADMIN, { saleId: id }))).toBe(before);
    const detail = await getSale(world.a.as.ADMIN, { saleId: id });
    expect(detail).toMatchObject({ taxRatePercent: "7.50", taxTotal: "593.02", costTotal: "5000.00" });
    expect(detail.lines[0]).toMatchObject({ unitName: "carton", baseQuantity: "100.000", unitPrice: "8500.00", lineTotal: "8500.00" });
  });

  it("cannot be changed or deleted, even directly in the database", async () => {
    const { id } = await postSale(world.a.as.CASHIER, sale([singles("1")], "100.00", "200"));
    const db = getDb();
    const line = await db.saleLine.findFirstOrThrow({ where: { saleId: id } });
    const payment = await db.payment.findFirstOrThrow({ where: { saleId: id } });

    await expect(db.sale.update({ where: { id }, data: { total: "1" } })).rejects.toThrow();
    await expect(db.sale.delete({ where: { id } })).rejects.toThrow();
    await expect(db.saleLine.update({ where: { id: line.id }, data: { unitPrice: "1" } })).rejects.toThrow();
    await expect(db.saleLine.delete({ where: { id: line.id } })).rejects.toThrow();
    await expect(db.payment.update({ where: { id: payment.id }, data: { amount: "1" } })).rejects.toThrow();
    await expect(db.payment.delete({ where: { id: payment.id } })).rejects.toThrow();
    // Change that does not add up, and a payment of nothing, cannot exist.
    const copy = { ...payment, id: randomUUID() };
    await expect(db.payment.create({ data: { ...copy, changeGiven: "50" } })).rejects.toThrow();
    await expect(db.payment.create({ data: { ...copy, amount: "0", tendered: null, changeGiven: null } })).rejects.toThrow();
  });
});

describe("the server trusts nothing the browser says about money", () => {
  it("refuses a sale whose price was tampered with, or is simply out of date", async () => {
    const before = await everything();
    const cheap = (await refusal(postSale(world.a.as.CASHIER, sale([{ ...cartons("1"), unitPrice: "85.00" }], "85.00")))).fieldErrors;
    expect(cheap["lines.0.unitPrice"]).toBe("The price of A Seed Sachet (carton) is ₦8,500.00, not ₦85.00. Reload the page to get the latest prices.");
    for (const unitPrice of ["", "free", "-8500", "8500.001"]) {
      expect((await refusal(postSale(world.a.as.CASHIER, sale([{ ...cartons("1"), unitPrice }], "8500.00")))).fieldErrors, unitPrice).toHaveProperty(["lines.0.unitPrice"]);
    }
    expect(await everything()).toBe(before);

    // The admin puts the price up while the cashier's screen still shows the old one.
    await setUnitPrice(world.a.as.ADMIN, { unitId: cartonId, price: "9000" });
    const stale = (await refusal(postSale(world.a.as.CASHIER, sale([cartons("1")], "8500.00")))).fieldErrors;
    expect(stale["lines.0.unitPrice"]).toContain("is ₦9,000.00, not ₦8,500.00");
    expect(await getDb().sale.count()).toBe(0);
  });

  it("refuses a total that is not the sum of the lines, and too little cash", async () => {
    const before = await everything();
    expect((await refusal(postSale(world.a.as.CASHIER, sale([cartons("1"), singles("3")], "8500.00", "9000")))).fieldErrors).toHaveProperty("expectedTotal");
    expect((await refusal(postSale(world.a.as.CASHIER, sale([cartons("1")], "eight thousand", "9000")))).fieldErrors).toHaveProperty("expectedTotal");
    const short = (await refusal(postSale(world.a.as.CASHIER, sale([cartons("1")], "8500.00", "8000")))).fieldErrors;
    expect(short["payments.0.tendered"]).toBe("The cash received is ₦500.00 short of ₦8,500.00.");
    for (const tendered of ["plenty", "-1", "9,000"]) {
      expect((await refusal(postSale(world.a.as.CASHIER, sale([cartons("1")], "8500.00", tendered)))).fieldErrors, tendered).toHaveProperty(["payments.0.tendered"]);
    }
    expect(await everything()).toBe(before);
  });

  it("refuses bad quantities, unknown or withdrawn products and units, no lines, and a terminal that is out of use", async () => {
    const before = await everything();
    const attempt = async (input: Record<string, unknown>) => Object.keys((await refusal(postSale(world.a.as.CASHIER, input))).fieldErrors);
    for (const quantity of ["0", "-1", "one", "1.2345", ""]) {
      expect(await attempt(sale([singles(quantity)], "100.00")), quantity).toEqual(["lines.0.quantity"]);
    }
    expect(await attempt(sale([{ ...singles("1"), productId: randomUUID() }], "100.00"))).toEqual(["lines.0.productId"]);
    expect(await attempt(sale([{ ...singles("1"), unitId: randomUUID() }], "100.00"))).toEqual(["lines.0.unitId"]);
    expect(await attempt(sale([], "0.00"))).toEqual(["lines"]);
    expect(await attempt(sale([singles("1")], "100.00", "100", { terminalId: randomUUID() }))).toEqual(["terminalId"]);
    expect(await attempt(sale([singles("1")], "100.00", "100", { requestId: "nope" }))).toEqual(["requestId"]);
    expect(await everything()).toBe(before);

    const second = await secondTill();
    await setTerminalActive(world.a.as.ADMIN, { terminalId: second.id, active: false });
    expect(await attempt(sale([singles("1")], "100.00", "100", { terminalId: second.id }))).toEqual(["terminalId"]);
    await retireUnit(world.a.as.ADMIN, { unitId: cartonId });
    expect(await attempt(sale([cartons("1")], "8500.00"))).toEqual(["lines.0.unitId"]);
    await setProductActive(world.a.as.ADMIN, { productId: world.a.product.id, active: false });
    expect(await attempt(sale([singles("1")], "100.00"))).toEqual(["lines.0.productId"]);
    expect(await getDb().sale.count()).toBe(0);
  });
});

describe("stock", () => {
  it("refuses a sale of more than the Shelf holds — even though the Storeroom has more — and sells nothing of it", async () => {
    const npk = await weighed();
    const before = await everything();
    const error = await refusal(
      postSale(world.a.as.CASHIER, sale([{ productId: npk.productId, unitId: npk.kgId, quantity: "1", unitPrice: "1250.50" }, cartons("2"), singles("1")], "18350.50")),
    );
    expect(error.message).toBe("Nothing was sold: there is not enough stock.");
    expect(error.fieldErrors).toEqual({
      "lines.1.quantity": 'Only 200 single of "A Seed Sachet" is in Shelf. This sale needs 201 single.',
      "lines.2.quantity": 'Only 200 single of "A Seed Sachet" is in Shelf. This sale needs 201 single.',
    });
    expect(await everything()).toBe(before);

    // Exactly what is there can be sold.
    await postSale(world.a.as.CASHIER, sale([cartons("2")], "17000.00"));
    expect(await onShelf()).toBe("0.000");
  });

  it("lets a manager, admin or owner sell a line straight from the Storeroom; a cashier cannot", async () => {
    const fromStore = { ...cartons("1"), fromStoreroom: true };
    const before = await everything();
    expect((await refusal(postSale(world.a.as.CASHIER, sale([fromStore], "8500.00")))).fieldErrors).toHaveProperty(["lines.0.fromStoreroom"]);
    expect(await everything()).toBe(before);

    const { id } = await postSale(world.a.as.MANAGER, sale([fromStore, singles("2")], "8700.00"));
    expect(await held(world.a.storeroomId)).toBe("0.000");
    expect(await onShelf()).toBe("198.000");
    expect((await getSale(world.a.as.MANAGER, { saleId: id })).lines.map((line) => line.locationName)).toEqual(["Storeroom", "Shelf"]);

    expect((await getCheckoutCatalogue(world.a.as.CASHIER)).canSellFromStoreroom).toBe(false);
    expect((await getCheckoutCatalogue(world.ownerInA)).canSellFromStoreroom).toBe(true);
  });
});

describe("several tills at once, and repeated submissions", () => {
  it("saves a sale once when the same sale is sent again, or many times at the same instant", async () => {
    const request = sale([singles("3")], "300.00", "500");
    const first = await postSale(world.a.as.CASHIER, request);
    const again = await postSale(world.a.as.CASHIER, request);
    expect(again).toEqual({ ...first, alreadySaved: true });

    const other = sale([packs("1")], "900.00", "1000");
    const results = await Promise.all(Array.from({ length: 5 }, () => postSale(world.a.as.CASHIER, other)));
    expect(results.filter((result) => !result.alreadySaved)).toHaveLength(1);
    expect(new Set(results.map((result) => result.receiptNumber))).toEqual(new Set(["T1-000002"]));

    expect(await getDb().sale.count()).toBe(2);
    expect(await getDb().payment.count()).toBe(2);
    expect(await onShelf()).toBe("187.000");
  });

  it("two sales of the last unit at the same instant: one succeeds, one is refused, stock ends at exactly 0", async () => {
    await postSale(world.a.as.CASHIER, sale([singles("199")], "19900.00"));
    expect(await onShelf()).toBe("1.000");
    const second = await secondTill();

    const outcomes = await Promise.allSettled([
      postSale(world.a.as.CASHIER, sale([singles("1")], "100.00")),
      postSale(world.a.as.MANAGER, sale([singles("1")], "100.00", "100.00", { terminalId: second.id })),
    ]);
    const refused = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ValidationError);
    expect(refused[0].reason.fieldErrors["lines.0.quantity"]).toContain("Only 0 single");

    expect(await onShelf()).toBe("0.000");
    expect(await getDb().sale.count()).toBe(2);
    expect(await getDb().payment.count()).toBe(2);
  });

  it("stays exact through many sales, a delivery and a price check at the same instant", async () => {
    const second = await secondTill();
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => postSale(world.a.as.CASHIER, sale([singles("7")], "700.00"))),
      ...Array.from({ length: 6 }, () => postSale(world.a.as.MANAGER, sale([packs("1")], "900.00", "900.00", { terminalId: second.id }))),
      deliver(world.a, world.a.shelfId, [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "50", unitCost: "50" }]),
    ]);
    // 200 − 42 − 60 + 50
    expect(await onShelf()).toBe("148.000");
    const numbers = results.filter((result) => result !== undefined).map((result) => result!.receiptNumber).sort();
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6].flatMap((n) => [`T1-00000${n}`]).concat([1, 2, 3, 4, 5, 6].map((n) => `T2-00000${n}`)));
    const totals = await getDb().sale.aggregate({ _sum: { total: true } });
    expect(totals._sum.total?.toFixed(2)).toBe("9600.00");
  });
});

describe("a busy shop", () => {
  it("sales, deliveries, transfers and adjustments of one product all at the same instant: every one is saved, and the stock is exact", async () => {
    const second = await secondTill();
    const single = world.a.product.baseUnitId;
    const work: Promise<unknown>[] = [];
    for (let round = 0; round < 4; round++) {
      work.push(postSale(world.a.as.CASHIER, sale([singles("7")], "700.00")));
      work.push(postSale(world.a.as.MANAGER, sale([singles("7")], "700.00", "700.00", { terminalId: second.id })));
    }
    for (let round = 0; round < 3; round++) {
      work.push(deliver(world.a, world.a.shelfId, [{ productId: world.a.product.id, unitId: single, quantity: "50", unitCost: "50" }]));
      work.push(
        transferStock(world.a.as.STOREKEEPER, {
          requestId: randomUUID(),
          fromLocationId: world.a.storeroomId,
          toLocationId: world.a.shelfId,
          lines: [{ productId: world.a.product.id, unitId: single, quantity: "10" }],
        }),
      );
    }
    for (let round = 0; round < 2; round++) {
      work.push(
        recordAdjustment(world.a.as.MANAGER, {
          requestId: randomUUID(),
          locationId: world.a.shelfId,
          lines: [{ productId: world.a.product.id, unitId: single, direction: "add", quantity: "5", reason: "FOUND" }],
        }),
      );
    }
    const outcomes = await Promise.allSettled(work);
    expect(outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => String((outcome as PromiseRejectedResult).reason))).toEqual([]);

    // Shelf: 200 − 8 × 7 + 3 × 50 + 3 × 10 + 2 × 5. Storeroom: 100 − 3 × 10.
    expect(await onShelf()).toBe("334.000");
    expect(await held(world.a.storeroomId)).toBe("70.000");
    expect(await getDb().sale.count()).toBe(8);
    // Everything was bought at ₦50, so whatever the order, the average cost is still ₦50.
    expect((await getDb().product.findUniqueOrThrow({ where: { id: world.a.product.id } })).averageCost.toFixed(4)).toBe("50.0000");
  });
});

describe("a failure halfway through saving a sale", () => {
  it("leaves no sale, no stock change and no payment; the receipt number is not used up; the same sale can then be saved", async () => {
    const before = await everything();
    // The payment is the last thing written. Make the database refuse it.
    await getDb().$executeRawUnsafe(
      "CREATE TRIGGER `payment_test_failure` BEFORE INSERT ON `payment` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Simulated failure while saving'",
    );
    const request = sale([cartons("1"), singles("3")], "8800.00", "9000");
    await expect(postSale(world.a.as.CASHIER, request)).rejects.toThrow();

    expect(await everything()).toBe(before);
    expect(await onShelf()).toBe("200.000");
    await expectBalancesMatchMovements();

    await getDb().$executeRawUnsafe("DROP TRIGGER `payment_test_failure`");
    expect(await postSale(world.a.as.CASHIER, request)).toMatchObject({ receiptNumber: "T1-000001", alreadySaved: false });
    expect(await postSale(world.a.as.CASHIER, request)).toMatchObject({ receiptNumber: "T1-000001", alreadySaved: true });
    expect(await onShelf()).toBe("97.000");
  });
});

describe("who may sell and see sales, and business separation", () => {
  it("lets cashier, manager, admin and owner sell; refuses the storekeeper and the accountant", async () => {
    for (const role of ["STOREKEEPER", "ACCOUNTANT"] as const) {
      await expect(postSale(world.a.as[role], sale([singles("1")], "100.00"))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getCheckoutCatalogue(world.a.as[role])).rejects.toBeInstanceOf(ForbiddenError);
    }
    const contexts: AppContext[] = [world.a.as.CASHIER, world.a.as.MANAGER, world.a.as.ADMIN, world.ownerInA];
    for (const context of contexts) await postSale(context, sale([singles("1")], "100.00"));
    expect(await onShelf()).toBe("196.000");
  });

  it("shows a cashier only their own sales; the sales report readers see all; a storekeeper sees none", async () => {
    const mine = await postSale(world.a.as.CASHIER, sale([singles("1")], "100.00"));
    const theirs = await postSale(world.a.as.MANAGER, sale([packs("1")], "900.00"));

    const own = await listSales(world.a.as.CASHIER);
    expect(own).toMatchObject({ ownOnly: true, sumOfTotals: "100.00" });
    expect(own.sales.map((row) => row.receiptNumber)).toEqual(["T1-000001"]);
    await expect(getSale(world.a.as.CASHIER, { saleId: theirs.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordReceiptPrint(world.a.as.CASHIER, { saleId: theirs.id })).rejects.toBeInstanceOf(NotFoundError);

    for (const context of [world.a.as.ACCOUNTANT, world.a.as.MANAGER, world.a.as.ADMIN, world.ownerInA]) {
      const all = await listSales(context);
      expect(all).toMatchObject({ ownOnly: false, sumOfTotals: "1000.00" });
      expect(all.sales.map((row) => [row.receiptNumber, row.cashierName, row.total])).toEqual([
        ["T1-000002", "Test a.manager", "900.00"],
        ["T1-000001", "Test a.cashier", "100.00"],
      ]);
      expect((await getSale(context, { saleId: mine.id })).total).toBe("100.00");
    }
    expect((await listSales(world.a.as.ADMIN, { search: "T1-000002" })).sales).toHaveLength(1);
    expect((await listSales(world.a.as.ADMIN, { search: "cashier" })).sales.map((row) => row.receiptNumber)).toEqual(["T1-000001"]);
    expect((await listSales(world.a.as.ADMIN, { search: "seed sachet" })).sales).toHaveLength(2);
    expect(await listSales(world.a.as.ADMIN, { to: "2020-01-01" })).toMatchObject({ sales: [], sumOfTotals: "0.00" });

    await expect(listSales(world.a.as.STOREKEEPER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getSale(world.a.as.STOREKEEPER, { saleId: mine.id })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a cashier of business A cannot sell business B's products or stock, nor use its terminal, nor see its sales", async () => {
    await deliver(world.b, world.b.shelfId, [{ productId: world.b.product.id, unitId: world.b.product.baseUnitId, quantity: "5", unitCost: "50" }]);
    const before = await everything();
    const theirLine = { productId: world.b.product.id, unitId: world.b.product.baseUnitId, quantity: "1", unitPrice: "100.00" };
    const attempt = async (input: Record<string, unknown>) => Object.keys((await refusal(postSale(world.a.as.CASHIER, input))).fieldErrors);

    expect(await attempt(sale([theirLine], "100.00"))).toEqual(["lines.0.productId"]);
    expect(await attempt(sale([{ ...singles("1"), unitId: world.b.product.baseUnitId }], "100.00"))).toEqual(["lines.0.unitId"]);
    expect(await attempt(sale([singles("1")], "100.00", "100", { terminalId: world.b.terminalId }))).toEqual(["terminalId"]);
    expect(await everything()).toBe(before);
    expect(await held(world.b.shelfId, world.b.product.id)).toBe("5.000");

    const inB = await postSale(world.b.as.CASHIER, saleInB());
    await expect(getSale(world.a.as.ADMIN, { saleId: inB.id })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listSales(world.a.as.ADMIN)).sales).toEqual([]);
    expect((await getCheckoutCatalogue(world.a.as.CASHIER)).products.map((product) => product.name)).toEqual(["A Seed Sachet"]);
    // The same sale ID used in another business is simply a different sale there.
    const request = sale([singles("1")], "100.00");
    await postSale(world.a.as.CASHIER, request);
    await postSale(world.b.as.CASHIER, { ...saleInB(), requestId: request.requestId });
    expect(await getDb().sale.count()).toBe(3);
  });
});

describe("the checkout's copy of the catalogue, and receipts", () => {
  it("lists products on sale with their units, prices and stock, and leaves out what cannot be sold", async () => {
    await createProduct(world.a.as.ADMIN, { name: "Not For Sale", code: "", barcode: "", baseUnitName: "piece", allowsFraction: false, taxable: true, tracksBatch: false, tracksExpiry: false, baseForSale: false, basePrice: "" });
    const catalogue = await getCheckoutCatalogue(world.a.as.CASHIER);
    expect(catalogue).toMatchObject({ businessName: "Business A", taxRatePercent: "0.00" });
    expect(catalogue.terminals).toEqual([{ id: world.a.terminalId, code: "T1", name: expect.any(String), tillOpen: true }]);
    expect(catalogue.paymentMethods).toEqual([
      { id: world.a.cashMethodId, name: "Cash", kind: "CASH" },
      { id: world.a.transferMethodId, name: "Bank transfer", kind: "TRANSFER" },
    ]);
    expect(catalogue.products).toHaveLength(1);
    expect(catalogue.products[0]).toMatchObject({ name: "A Seed Sachet", code: "A-001", allowsFraction: false, baseUnitName: "single", onShelf: "200.000", inStoreroom: "100.000" });
    expect(catalogue.products[0].units.map((unit) => [unit.name, unit.factor, unit.price])).toEqual([
      ["single", "1.000", "100.00"],
      ["pack", "10.000", "900.00"],
      ["carton", "100.000", "8500.00"],
    ]);
    // Cost prices are never part of what the checkout holds.
    expect(JSON.stringify(catalogue)).not.toMatch(/cost/i);
  });

  it("marks every print after the first as a reprint and logs it", async () => {
    const { id } = await postSale(world.a.as.CASHIER, sale([singles("1")], "100.00"));
    expect(await recordReceiptPrint(world.a.as.CASHIER, { saleId: id })).toEqual({ reprint: false });
    expect(await recordReceiptPrint(world.a.as.MANAGER, { saleId: id })).toEqual({ reprint: true });
    expect((await getSale(world.a.as.CASHIER, { saleId: id })).printCount).toBe(2);

    const log = await getDb().activityLog.findMany({ where: { action: "sale.receipt_reprinted" } });
    expect(log.map((entry) => entry.summary)).toEqual(["Test a.manager printed receipt T1-000001 again."]);
    const print = await getDb().saleReceiptPrint.findFirstOrThrow();
    await expect(getDb().saleReceiptPrint.delete({ where: { id: print.id } })).rejects.toThrow();
  });

  it("prints the business's name, header, footer and tax number as they are set", async () => {
    await getDb().business.update({ where: { id: world.a.id }, data: { receiptHeader: "12 Market Road\n0800 000 0000", receiptFooter: "No refund after 7 days", taxNumber: "12345678-0001" } });
    const { id } = await postSale(world.a.as.CASHIER, sale([singles("1")], "100.00"));
    expect((await getSale(world.a.as.CASHIER, { saleId: id })).business).toEqual({
      name: "Business A",
      receiptHeader: "12 Market Road\n0800 000 0000",
      receiptFooter: "No refund after 7 days",
      taxNumber: "12345678-0001",
    });
  });
});
