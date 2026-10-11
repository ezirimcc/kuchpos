import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMPORT_SHEETS, IMPORT_TEMPLATE_PATH } from "@/lib/import-template";
import { shopDayStart, shopToday } from "@/lib/format";
import { getCustomer, getCustomerStatement, listCustomers, recordRepayment } from "@/server/business/customers";
import { importNumber, listImports, OPENING_STOCK_SUPPLIER, previewSetupImport, runSetupImport } from "@/server/business/imports";
import { getDebtReport } from "@/server/business/reports";
import { postSale } from "@/server/business/sales";
import { listReceipts } from "@/server/business/stock";
import { openTill } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { readWorkbook } from "@/server/workbook";
import { makeWorkbook, type Rows } from "../support/workbook";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, type World } from "../support/world";

/** Bringing a shop's products, customers and counted stock in from its Excel workbook (M15, C66). */

let world: World;
const today = shopToday();
/** The shop's records start a few days ago. */
const startingDay = shopToday(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
const about = { fileName: "green-valley.xlsx", startingDay };

beforeEach(async () => {
  await getDb().$executeRawUnsafe("DROP TRIGGER IF EXISTS `import_test_failure`");
  world = await createWorld();
});

afterEach(async () => {
  await getDb().$executeRawUnsafe("DROP TRIGGER IF EXISTS `import_test_failure`");
  await expectBalancesMatchMovements();
  await expectCustomerBalancesMatchEntries();
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

/** A small, sound workbook: two new products, one the business already has, two customers, and the stock count. */
const sound = (): { products: Rows; customers: Rows; stock: Rows } => ({
  products: [
    { code: "TOM-001", name: "Tomato Seed Sachet", category: "Vegetable seeds", unit: "sachet", contains: "1", price: "500", expiry: "Yes" },
    { code: "TOM-001", name: "Tomato Seed Sachet", category: "Vegetable seeds", unit: "carton", contains: 100, price: 45000, expiry: "Yes" },
    { code: "FERT-01", name: "NPK Fertilizer", category: "Seeds", fractions: "yes", taxable: "No", unit: "kg", contains: "1", price: "800.50" },
    { code: "FERT-01", name: "NPK Fertilizer", category: "Seeds", fractions: "yes", taxable: "No", unit: "bag", contains: "50", bought: "Yes" },
    // Already in KuchPos under this code: left exactly as it is.
    { code: "a-001", name: "Something else entirely", unit: "single", contains: "1", price: "1" },
  ],
  customers: [
    { name: "Chief Okoro", phone: "0803 111 2222", address: "12 Market Road", city: "Aba", state: "Abia", creditLimit: "50000", owed: "12500" },
    { name: "Mama Nkechi", phone: "08044443333" },
  ],
  stock: [
    { code: "TOM-001", unit: "carton", quantity: "4", cost: "38000", expiry: new Date("2027-03-31T00:00:00.000Z") },
    { code: "TOM-001", unit: "sachet", quantity: 7, cost: 400, expiry: "31/03/2027" },
    { code: "FERT-01", unit: "kg", quantity: "12.5", cost: "600" },
    // Opening stock for a product the business already had.
    { code: "A-001", unit: "pack", quantity: "2", cost: "500" },
  ],
});

const counts = async () => {
  const db = getDb();
  return {
    products: await db.product.count(),
    units: await db.productUnit.count(),
    customers: await db.customer.count(),
    entries: await db.customerAccountEntry.count(),
    receipts: await db.goodsReceipt.count(),
    movements: await db.stockMovement.count(),
    imports: await db.importRun.count(),
    categories: await db.category.count(),
  };
};

describe("the template", () => {
  it("is the workbook the import expects: the five sheets with exactly the headings it looks for", async () => {
    const workbook = await readWorkbook(readFileSync(join(process.cwd(), "public", IMPORT_TEMPLATE_PATH)));
    for (const sheet of IMPORT_SHEETS) {
      const headings = (workbook.get(sheet.name.toLowerCase())?.[0] ?? []).map((cell) => String(cell).replace(" *", ""));
      expect(headings, sheet.name).toEqual(Object.values(sheet.columns).map((column) => column.heading));
    }
    // Uploaded as it comes, it has nothing to bring in: rows 1 to 3 are never imported.
    const untouched = readFileSync(join(process.cwd(), "public", IMPORT_TEMPLATE_PATH));
    expect((await refusal(previewSetupImport(world.a.as.ADMIN, about, untouched))).message).toMatch(/Nothing to bring in/);
  });
});

describe("bringing in products, customers and stock", () => {
  it("first shows what would be brought in, saving nothing; then brings in all of it", async () => {
    const file = await makeWorkbook(sound());
    const before = await counts();
    const preview = await previewSetupImport(world.a.as.ADMIN, about, file);
    expect(preview).toMatchObject({
      newProducts: 2,
      newUnits: 4,
      newCategories: 1,
      newCustomers: 2,
      openingDebt: "12500.00",
      stockLines: 4,
      // 4 × 38,000 + 7 × 400 + 12.5 × 600 + 2 × 500
      stockValue: "163300.00",
      productsAlreadyThere: 1,
      customersAlreadyThere: 0,
      problems: [],
      problemCount: 0,
      alreadyImported: null,
      canImport: true,
    });
    expect(await counts()).toEqual(before);

    const done = await runSetupImport(world.a.as.ADMIN, about, file);
    expect(done.number).toBe(1);
    const db = getDb();

    // Products, their units and first prices.
    const tomato = await db.product.findFirstOrThrow({ where: { businessId: world.a.id, code: "TOM-001" }, include: { units: { orderBy: { factor: "asc" } }, category: true } });
    expect(tomato).toMatchObject({ name: "Tomato Seed Sachet", allowsFraction: false, taxable: true, tracksBatch: false, tracksExpiry: true, category: { name: "Vegetable seeds" } });
    expect(tomato.units.map((unit) => [unit.name, unit.factor.toFixed(3), unit.isBase, unit.forSale, unit.forPurchase, unit.price?.toFixed(2) ?? null, unit.activeName])).toEqual([
      ["sachet", "1.000", true, true, true, "500.00", "sachet"],
      ["carton", "100.000", false, true, true, "45000.00", "carton"],
    ]);
    const fertilizer = await db.product.findFirstOrThrow({ where: { businessId: world.a.id, code: "FERT-01" }, include: { units: { orderBy: { factor: "asc" } }, category: true } });
    expect(fertilizer).toMatchObject({ allowsFraction: true, taxable: false, category: { name: "Seeds" } });
    // A unit with no selling price is not for sale.
    expect(fertilizer.units.map((unit) => [unit.name, unit.forSale, unit.price?.toFixed(2) ?? null])).toEqual([["kg", true, "800.50"], ["bag", false, null]]);
    expect(await db.priceChange.count({ where: { productId: { in: [tomato.id, fertilizer.id] }, oldPrice: null } })).toBe(3);
    // The product that was already there is untouched.
    expect((await db.product.findUniqueOrThrow({ where: { id: world.a.product.id } })).name).toBe("A Seed Sachet");

    // Customers, the credit limit, and what was owed — dated the starting day.
    const [okoro, nkechi] = (await listCustomers(world.a.as.ADMIN)).customers;
    expect(okoro).toMatchObject({ name: "Chief Okoro", phone: "08031112222", city: "Aba", state: "Abia", creditLimit: "50000.00", balance: "12500.00" });
    expect(nkechi).toMatchObject({ name: "Mama Nkechi", creditLimit: null, balance: "0.00" });
    const statement = await getCustomerStatement(world.a.as.ADMIN, { customerId: okoro.id });
    expect(statement.lines).toHaveLength(1);
    expect(statement.lines[0]).toMatchObject({ type: "OPENING_BALANCE", amount: "12500.00", balanceAfter: "12500.00", documentNumber: "IM-000001" });
    expect(statement.lines[0].createdAt.getTime()).toBe(shopDayStart(startingDay)!.getTime());

    // The stock: one delivery from "Opening stock", onto the Shelf, as opening-balance movements of the starting day.
    const deliveries = (await listReceipts(world.a.as.ADMIN)).receipts;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ number: 1, supplierName: OPENING_STOCK_SUPPLIER, locationName: "Shelf", receivedOn: startingDay, lineCount: 4, totalCost: "163300.00", backdated: true });
    const balances = await db.stockBalance.findMany({ where: { businessId: world.a.id } });
    const held = (productId: string) => balances.filter((balance) => balance.productId === productId).map((balance) => [balance.locationId === world.a.shelfId, balance.quantity.toFixed(3)]);
    expect(held(tomato.id)).toEqual([[true, "407.000"]]);
    expect(held(fertilizer.id)).toEqual([[true, "12.500"]]);
    expect(held(world.a.product.id)).toEqual([[true, "20.000"]]);
    const movements = await db.stockMovement.findMany({ where: { businessId: world.a.id } });
    expect(movements.map((movement) => movement.type)).toEqual(["OPENING_BALANCE", "OPENING_BALANCE", "OPENING_BALANCE", "OPENING_BALANCE"]);
    expect(new Set(movements.map((movement) => movement.createdAt.getTime()))).toEqual(new Set([shopDayStart(startingDay)!.getTime()]));
    // Average cost per smallest unit: (152,000 + 2,800) ÷ 407; 600 a kg; 1,000 ÷ 20.
    expect((await db.product.findUniqueOrThrow({ where: { id: tomato.id } })).averageCost.toFixed(4)).toBe("380.3440");
    expect((await db.product.findUniqueOrThrow({ where: { id: fertilizer.id } })).averageCost.toFixed(4)).toBe("600.0000");
    expect((await db.product.findUniqueOrThrow({ where: { id: world.a.product.id } })).averageCost.toFixed(4)).toBe("50.0000");
    const line = await db.goodsReceiptLine.findFirstOrThrow({ where: { productId: tomato.id, unitName: "sachet" } });
    expect(line.expiryDate?.toISOString().slice(0, 10)).toBe("2027-03-31");

    // The import is on record, and in the activity log.
    expect(await listImports(world.a.as.ADMIN)).toEqual([
      expect.objectContaining({ number: 1, part: "SETUP", fileName: "green-valley.xlsx", startingDay, byName: "Test a.admin", summary: expect.objectContaining({ products: 2, customers: 2, stockLines: 4, stockValue: "163300.00" }) }),
    ]);
    expect((await db.activityLog.findFirstOrThrow({ where: { action: "import.setup" } })).summary).toBe(
      "Test a.admin brought in green-valley.xlsx (IM-000001): 2 products, 2 customers owing ₦12,500.00, and 4 lines of stock worth ₦163,300.00 at cost.",
    );

    // What came in can be sold at once.
    await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "0" });
    const sachet = tomato.units[0];
    const sale = await postSale(world.a.as.CASHIER, {
      requestId: randomUUID(),
      terminalId: world.a.terminalId,
      expectedTotal: "1500.00",
      payments: [{ methodId: world.a.cashMethodId, amount: "1500.00" }],
      lines: [{ productId: tomato.id, unitId: sachet.id, quantity: "3", unitPrice: "500.00" }],
    });
    expect(sale.total).toBe("1500.00");
  });

  it("cannot be brought in twice; a workbook with rows added brings in only what is new", async () => {
    const file = await makeWorkbook(sound());
    await runSetupImport(world.a.as.ADMIN, about, file);
    const after = await counts();

    expect((await previewSetupImport(world.a.as.ADMIN, about, file)).alreadyImported).toMatchObject({ number: 1, byName: "Test a.admin" });
    expect((await refusal(runSetupImport(world.a.as.ADMIN, about, file))).message).toMatch(/this exact file was already brought in as IM-000001/);
    expect(await counts()).toEqual(after);

    // The same rows with one more product and one more customer. The stock rows must come out: that stock is already in.
    const more = sound();
    more.products.push({ code: "ONI-001", name: "Onion Seed Tin", category: "Vegetable seeds", unit: "tin", contains: "1", price: "2500" });
    more.customers.push({ name: "Baba Tunde", phone: "08055556666" });
    const again = await previewSetupImport(world.a.as.ADMIN, about, await makeWorkbook(more));
    expect(again.problems.map((problem) => [problem.sheet, problem.row])).toEqual([["Stock", 4], ["Stock", 5], ["Stock", 6], ["Stock", 7]]);
    expect(again.problems[0].message).toMatch(/already has opening stock in KuchPos/);

    const withoutStock = await makeWorkbook({ ...more, stock: [{ code: "ONI-001", unit: "tin", quantity: "30", cost: "1800" }] });
    expect(await previewSetupImport(world.a.as.ADMIN, about, withoutStock)).toMatchObject({ newProducts: 1, newCustomers: 1, productsAlreadyThere: 3, customersAlreadyThere: 2, stockLines: 1, canImport: true });
    expect((await runSetupImport(world.a.as.ADMIN, about, withoutStock)).number).toBe(2);
    expect(await counts()).toMatchObject({ products: after.products + 1, customers: after.customers + 1, imports: 2, receipts: 2 });
    // The supplier "Opening stock" was not created a second time.
    expect(await getDb().supplier.count({ where: { businessId: world.a.id, name: OPENING_STOCK_SUPPLIER } })).toBe(1);
    // A workbook with nothing new says so.
    expect((await previewSetupImport(world.a.as.ADMIN, about, await makeWorkbook({ products: more.products }))).problems[0].message).toMatch(/already in KuchPos, so there is nothing to bring in/);
  });

  it("reports every problem by sheet and row, and saves nothing while there is one", async () => {
    const before = await counts();
    const file = await makeWorkbook({
      products: [
        { code: "GOOD-1", name: "Good Product", unit: "piece", contains: "1", price: "100" },
        { code: "P-2", name: "No base unit", unit: "carton", contains: "12", price: "1,250" }, // row 5: a comma in the price
        { code: "P-3", name: "Two base units", unit: "piece", contains: "1" },
        { code: "P-3", name: "Two base units", unit: "each", contains: "1" }, // row 6/7: two units that contain 1
        { code: "P-4", name: "Half Carton", unit: "piece", contains: "1" },
        { code: "P-4", name: "Half Carton", unit: "carton", contains: "12.5" }, // a whole-unit product with a fractional carton
        { code: "P-5", name: "One Name", unit: "piece", contains: "1" },
        { code: "P-5", name: "Another Name", unit: "pack", contains: "6" }, // row 11: one code, two names
        { code: "P-6", name: "A Seed Sachet", unit: "piece", contains: "1" }, // row 12: the name is already in KuchPos
        { code: "P-7", name: "Maybe", unit: "piece", contains: "1", taxable: "perhaps" }, // row 13
        { code: "", name: "No code", unit: "piece", contains: "1" }, // row 14
        { code: "P-8", name: "Zero", unit: "piece", contains: "0" }, // row 15
      ],
      customers: [
        { name: "Ada", phone: "08031234567" },
        { name: "Ada Again", phone: "0803-123-4567" }, // row 5: the same phone
        { name: "Bad Phone", phone: "call me" }, // row 6
        { name: "B", phone: "08090000000" }, // row 7: no real name
        { name: "Owes Words", phone: "08090000001", owed: "plenty" }, // row 8
      ],
      stock: [
        { code: "NOPE-1", unit: "piece", quantity: "1", cost: "10" }, // row 4: unknown product
        { code: "GOOD-1", unit: "carton", quantity: "1", cost: "10" }, // row 5: not one of its units
        { code: "GOOD-1", unit: "piece", quantity: "2.5", cost: "10" }, // row 6: half a piece
        { code: "GOOD-1", unit: "piece", quantity: "-3", cost: "10" }, // row 7
        { code: "GOOD-1", unit: "piece", quantity: "3", cost: "" }, // row 8
        { code: "GOOD-1", unit: "piece", quantity: "3", cost: "10", expiry: "soon" }, // row 9
      ],
    });
    const preview = await previewSetupImport(world.a.as.ADMIN, about, file);
    expect(preview.canImport).toBe(false);
    const found = preview.problems.map((problem) => `${problem.sheet} ${problem.row}`);
    expect(found).toEqual([
      "Customers 5", "Customers 6", "Customers 7", "Customers 8",
      "Products 5", "Products 6", "Products 8", "Products 11", "Products 12", "Products 13", "Products 14", "Products 15",
      "Stock 4", "Stock 5", "Stock 6", "Stock 7", "Stock 8", "Stock 9",
    ]);
    const said = (sheet: string, row: number) => preview.problems.find((problem) => problem.sheet === sheet && problem.row === row)!.message;
    expect(said("Products", 5)).toBe('The selling price "1,250" is not a plain amount. Type it as a number such as 1250 or 1250.50, with no commas or ₦ sign.');
    expect(said("Products", 6)).toBe('"Two base units" needs exactly one unit that contains 1 (its smallest unit); it has 2.');
    expect(said("Products", 11)).toBe('The code "P-5" is used for "One Name" on row 10 and for "Another Name" here. One code is one product.');
    expect(said("Customers", 5)).toBe("The phone number 08031234567 is also on row 4. Every customer needs a different one.");
    expect(said("Stock", 4)).toBe('The product code "NOPE-1" is not on the Products sheet and not in KuchPos.');
    expect(said("Stock", 5)).toBe('"Good Product" has no unit called "carton". Its units are: piece.');
    expect(said("Stock", 6)).toBe('"Good Product" is counted in whole units; 2.5 is not a whole number.');

    expect((await refusal(runSetupImport(world.a.as.ADMIN, about, file))).message).toBe("Nothing was brought in: the workbook has 18 problems. Correct them in Excel and upload it again.");
    expect(await counts()).toEqual(before);
  });

  it("refuses a file that is not a workbook, a missing heading, and a starting day in the future", async () => {
    expect((await refusal(previewSetupImport(world.a.as.ADMIN, about, Buffer.from("name,phone\nAda,0803")))).message).toMatch(/could not be read as an Excel workbook/);
    expect((await refusal(previewSetupImport(world.a.as.ADMIN, about, Buffer.alloc(0)))).message).toMatch(/empty/);
    expect((await refusal(previewSetupImport(world.a.as.ADMIN, about, Buffer.alloc(5 * 1024 * 1024 + 1)))).message).toMatch(/larger than 5 MB/);
    const tomorrow = shopToday(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const file = await makeWorkbook(sound());
    expect((await refusal(previewSetupImport(world.a.as.ADMIN, { ...about, startingDay: tomorrow }, file))).fieldErrors).toHaveProperty("startingDay");
    expect((await refusal(previewSetupImport(world.a.as.ADMIN, { ...about, startingDay: "soon" }, file))).fieldErrors).toHaveProperty("startingDay");
    // Stock counted today is not backdated.
    await runSetupImport(world.a.as.ADMIN, { ...about, startingDay: today }, file);
    expect((await listReceipts(world.a.as.ADMIN)).receipts[0]).toMatchObject({ receivedOn: today, backdated: false });
  });

  it("is all or nothing: a failure partway leaves no product, customer, stock or record of the import", async () => {
    const file = await makeWorkbook(sound());
    const before = await counts();
    // The stock is the last thing written. Make the database refuse it.
    await getDb().$executeRawUnsafe(
      "CREATE TRIGGER `import_test_failure` BEFORE INSERT ON `goods_receipt` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Simulated failure while importing'",
    );
    await expect(runSetupImport(world.a.as.ADMIN, about, file)).rejects.toThrow();
    expect(await counts()).toEqual(before);
    await getDb().$executeRawUnsafe("DROP TRIGGER `import_test_failure`");
    // The number was not used up, and the same file can now go in.
    expect((await runSetupImport(world.a.as.ADMIN, about, file)).number).toBe(1);
  });

  it("is for the admin and the owner only, and goes into the business that is open and no other", async () => {
    const file = await makeWorkbook(sound());
    for (const role of ["MANAGER", "ACCOUNTANT", "CASHIER", "STOREKEEPER"] as const) {
      await expect(previewSetupImport(world.a.as[role], about, file), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(runSetupImport(world.a.as[role], about, file), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listImports(world.a.as[role]), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(runSetupImport(world.ownerOutside, about, file)).rejects.toBeInstanceOf(ForbiddenError);
    await runSetupImport(world.ownerInA, about, file);
    const db = getDb();
    expect(await db.product.count({ where: { businessId: world.b.id } })).toBe(1);
    expect(await db.customer.count({ where: { businessId: world.b.id } })).toBe(0);
    expect(await listImports(world.b.as.ADMIN)).toEqual([]);
    // The very same file is new to business B: its own "A-001" does not exist there, so its stock row is a problem.
    const inB = await previewSetupImport(world.b.as.ADMIN, about, file);
    expect(inB).toMatchObject({ newProducts: 3, productsAlreadyThere: 0, alreadyImported: null });
    expect(inB.problems.map((problem) => [problem.sheet, problem.row])).toEqual([["Stock", 7]]);
    expect(importNumber(12)).toBe("IM-000012");
    await expect(db.importRun.updateMany({ data: { fileName: "x" } })).rejects.toThrow();
    await expect(db.importRun.deleteMany({})).rejects.toThrow();
  });
});

describe("a debt brought in from before KuchPos", () => {
  it("is paid off before newer debts, and is aged from the starting day", async () => {
    await runSetupImport(world.a.as.ADMIN, about, await makeWorkbook(sound()));
    const okoro = (await listCustomers(world.a.as.ADMIN, { search: "okoro" })).customers[0];
    await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "0" });
    // A new credit sale of ₦2,000 on top of the ₦12,500 from before.
    const sale = await postSale(world.a.as.CASHIER, {
      requestId: randomUUID(),
      terminalId: world.a.terminalId,
      expectedTotal: "1800.00",
      payments: [],
      customerId: okoro.id,
      creditAmount: "1800.00",
      lines: [{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "2", unitPrice: "900.00" }],
    });
    const report = await getDebtReport(world.a.as.ACCOUNTANT);
    expect(report.rows[0]).toMatchObject({ name: "Chief Okoro", current: "14300.00", total: "14300.00" });
    expect(report.rows[0].oldestSale?.getTime()).toBe(shopDayStart(startingDay)!.getTime());

    // ₦12,000 repaid: all of it goes to the old debt, none to the new sale.
    await recordRepayment(world.a.as.ACCOUNTANT, { requestId: randomUUID(), customerId: okoro.id, amount: "12000", methodId: world.a.transferMethodId });
    expect((await getCustomer(world.a.as.ADMIN, { customerId: okoro.id })).unpaidSales).toEqual([expect.objectContaining({ saleId: sale.id, outstanding: "1800.00" })]);
    // ₦1,000 more: the last ₦500 of the old debt, then ₦500 of the sale.
    await recordRepayment(world.a.as.ACCOUNTANT, { requestId: randomUUID(), customerId: okoro.id, amount: "1000", methodId: world.a.transferMethodId });
    expect((await getCustomer(world.a.as.ADMIN, { customerId: okoro.id })).unpaidSales).toEqual([expect.objectContaining({ outstanding: "1300.00" })]);
    expect((await getCustomer(world.a.as.ADMIN, { customerId: okoro.id })).balance).toBe("1300.00");
  });
});
