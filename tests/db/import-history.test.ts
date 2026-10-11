import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shopDayStart, shopToday } from "@/lib/format";
import { getCustomer, getCustomerStatement, listCustomers, recordRepayment } from "@/server/business/customers";
import { previewHistoryImport, runHistoryImport } from "@/server/business/import-history";
import { listImports, runSetupImport } from "@/server/business/imports";
import { listOfflineExceptions } from "@/server/business/offline";
import { getCollectionsReport, getSalesReport } from "@/server/business/reports";
import { getSale, listSales, postSale } from "@/server/business/sales";
import { listReceipts } from "@/server/business/stock";
import { closeTill, openTill } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { makeWorkbook, type Rows } from "../support/workbook";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, type World } from "../support/world";

/** Bringing in the deliveries and sales a shop made before it started using KuchPos (M15 step 3, C66). */

let world: World;
const DAY = 24 * 60 * 60 * 1000;
const today = shopToday();
/** The shop's records start five days ago; the workbook covers that day and the two after it. */
const day0 = shopToday(new Date(Date.now() - 5 * DAY));
const day1 = shopToday(new Date(Date.now() - 4 * DAY));
const day2 = shopToday(new Date(Date.now() - 3 * DAY));
const about = { fileName: "green-valley.xlsx", startingDay: day0 };
/** A day as a shop types it: day/month/year. */
const typed = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
/** The moment of a time of day on a shop day. */
const moment = (day: string, hours: number, minutes: number) => new Date(shopDayStart(day)!.getTime() + (hours * 60 + minutes) * 60_000);

beforeEach(async () => {
  await getDb().$executeRawUnsafe("DROP TRIGGER IF EXISTS `import_test_failure`");
  world = await createWorld();
  // Products, a customer who already owes ₦12,500, and 2 cartons (200 sachets) of tomato seed at ₦380 a sachet.
  await runSetupImport(
    world.a.as.ADMIN,
    about,
    await makeWorkbook({
      products: [
        { code: "TOM-001", name: "Tomato Seed Sachet", unit: "sachet", contains: "1", price: "500" },
        { code: "TOM-001", name: "Tomato Seed Sachet", unit: "carton", contains: "100", price: "45000" },
      ],
      customers: [{ name: "Chief Okoro", phone: "0803 111 2222", creditLimit: "15000", owed: "12500" }],
      stock: [{ code: "TOM-001", unit: "carton", quantity: "2", cost: "38000" }],
    }),
  );
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

/**
 * Three days of a shop's own records, typed out of order on purpose:
 *
 * day 0, 14:35  receipt 0457: 50 sachets at ₦500 = ₦25,000, cash.
 *               Leaves at ₦380 each (cost ₦19,000). 150 sachets left.
 * day 1         delivery D-014 from Agro Supplies: 1 carton of tomato at ₦40,000, 3 packs of A-001 at ₦600.
 *               Tomato: 250 sachets, average (150 × 380 + 40,000) ÷ 250 = ₦388. A-001: 30 singles at ₦60.
 * day 1, 09:10  receipt 0458, by Ngozi, to Chief Okoro: 1 carton at ₦44,000 (not today's price) and
 *               5 singles of A-001 at ₦100 = ₦44,500, less ₦500 discount = ₦44,000; ₦20,000 on credit
 *               (taking him to ₦32,500, over his ₦15,000 limit — it happened), ₦24,000 by bank transfer.
 *               Cost 100 × 388 + 5 × 60 = ₦39,100. Tomato 150 left, A-001 25 left.
 * day 2         receipt 0459 (no time): 4 packs of A-001 at ₦900 = ₦3,600, cash. 40 singles are needed and
 *               the records hold 25: all 25 leave, 15 are noted as short. Cost still 40 × 60 = ₦2,400.
 */
const history = (): { deliveries: Rows; sales: Rows } => ({
  deliveries: [
    { date: typed(day1), reference: "D-014", supplier: "Agro Supplies Ltd", code: "TOM-001", unit: "carton", quantity: "1", cost: "40000", note: "Paid in full" },
    { date: new Date(`${day1}T00:00:00.000Z`), reference: "D-014", supplier: "agro supplies ltd", code: "A-001", unit: "pack", quantity: 3, cost: 600 },
  ],
  sales: [
    { date: typed(day2), receipt: "0459", code: "A-001", unit: "pack", quantity: "4", price: "900", paidBy: "Cash" },
    { date: typed(day1), time: "09:10", receipt: "0458", code: "TOM-001", unit: "carton", quantity: "1", price: "44000", discount: "500", paidBy: "bank transfer", customerPhone: "08031112222", onCredit: "20000", soldBy: "Ngozi" },
    { date: typed(day1), time: "09:10", receipt: "0458", code: "a-001", unit: "single", quantity: "5", price: "100", discount: "500", paidBy: "Bank transfer", soldBy: "Ngozi" },
    { date: typed(day0), time: "14:35", receipt: "0457", code: "TOM-001", unit: "sachet", quantity: "50", price: "500", paidBy: "Cash" },
  ],
});

const counts = async () => {
  const db = getDb();
  return {
    sales: await db.sale.count(),
    lines: await db.saleLine.count(),
    payments: await db.payment.count(),
    receipts: await db.goodsReceipt.count(),
    movements: await db.stockMovement.count(),
    entries: await db.customerAccountEntry.count(),
    suppliers: await db.supplier.count(),
    exceptions: await db.offlineException.count(),
    imports: await db.importRun.count(),
  };
};

describe("bringing in deliveries and sales", () => {
  it("shows what would come in, saving nothing; then replays it all in the order it happened", async () => {
    const file = await makeWorkbook(history());
    const before = await counts();
    const preview = await previewHistoryImport(world.a.as.ADMIN, about, file);
    expect(preview).toMatchObject({
      deliveries: 1,
      deliveryLines: 2,
      deliveriesCost: "41800.00",
      newSuppliers: 1,
      sales: 3,
      saleLines: 4,
      salesTotal: "72600.00",
      discountTotal: "500.00",
      creditTotal: "20000.00",
      salesShortOfStock: 1,
      firstDay: day0,
      lastDay: day2,
      problems: [],
      alreadyImported: null,
      canImport: true,
    });
    expect(await counts()).toEqual(before);

    const done = await runHistoryImport(world.a.as.ADMIN, about, file);
    expect(done).toMatchObject({ number: 2, exceptions: 1 });
    const db = getDb();

    // Stock and average cost, exactly as worked out above.
    const tomato = await db.product.findFirstOrThrow({ where: { businessId: world.a.id, code: "TOM-001" } });
    const held = async (productId: string) => (await db.stockBalance.findMany({ where: { productId } })).map((balance) => [balance.locationId === world.a.shelfId, balance.quantity.toFixed(3)]);
    expect(await held(tomato.id)).toEqual([[true, "150.000"]]);
    expect(await held(world.a.product.id)).toEqual([[true, "0.000"]]);
    expect(tomato.averageCost.toFixed(4)).toBe("388.0000");
    expect((await db.product.findUniqueOrThrow({ where: { id: world.a.product.id } })).averageCost.toFixed(4)).toBe("60.0000");

    // The delivery: an ordinary one, dated its own day, with the shop's reference.
    const deliveries = (await listReceipts(world.a.as.ADMIN)).receipts;
    expect(deliveries[0]).toMatchObject({ number: 2, supplierName: "Agro Supplies Ltd", locationName: "Shelf", receivedOn: day1, lineCount: 2, totalCost: "41800.00", backdated: true });
    const delivery = await db.goodsReceipt.findFirstOrThrow({ where: { number: 2, businessId: world.a.id } });
    expect(delivery).toMatchObject({ invoiceNumber: "D-014", note: "Paid in full" });
    const received = await db.stockMovement.findMany({ where: { documentId: delivery.id } });
    expect(received.map((movement) => [movement.type, movement.createdAt.getTime()])).toEqual([
      ["RECEIPT", shopDayStart(day1)!.getTime()],
      ["RECEIPT", shopDayStart(day1)!.getTime()],
    ]);

    // The sales, each on its own day, numbered IMP- and in no till.
    const sales = (await listSales(world.a.as.MANAGER)).sales;
    expect(sales.map((sale) => [sale.receiptNumber, sale.total, sale.cashierName])).toEqual([
      ["IMP-0459", "3600.00", "Brought in from Excel"],
      ["IMP-0458", "44000.00", "Ngozi"],
      ["IMP-0457", "25000.00", "Brought in from Excel"],
    ]);
    const first = await db.sale.findFirstOrThrow({ where: { receiptNumber: "IMP-0457" }, include: { payments: true, lines: true } });
    expect(first).toMatchObject({ tillSessionId: null, offline: false, cashierUserId: null, importRunId: done.id, terminalId: world.a.terminalId });
    expect(first.sequence).toBeGreaterThan(2_000_000_000);
    expect(first.createdAt.getTime()).toBe(moment(day0, 14, 35).getTime());
    expect(first.costTotal.toFixed(2)).toBe("19000.00");
    expect(first.payments.map((payment) => [payment.kind, payment.amount.toFixed(2), payment.tendered?.toFixed(2), payment.changeGiven?.toFixed(2), payment.tillSessionId, payment.createdAt.getTime()])).toEqual([
      ["CASH", "25000.00", "25000.00", "0.00", null, moment(day0, 14, 35).getTime()],
    ]);

    const second = await getSale(world.a.as.MANAGER, { saleId: sales[1].id });
    expect(second).toMatchObject({
      subtotal: "44500.00",
      discountAmount: "500.00",
      total: "44000.00",
      costTotal: "39100.00",
      creditAmount: "20000.00",
      customer: { name: "Chief Okoro", phone: "08031112222" },
      offline: null,
      imported: { byName: "Test a.admin", exceptions: [] },
    });
    expect(second.createdAt.getTime()).toBe(moment(day1, 9, 10).getTime());
    expect(second.lines.map((line) => [line.productName, line.unitName, line.quantity, line.unitPrice, line.lineTotal])).toEqual([
      ["Tomato Seed Sachet", "carton", "1.000", "44000.00", "44000.00"],
      ["A Seed Sachet", "single", "5.000", "100.00", "500.00"],
    ]);
    expect(second.payments.map((payment) => [payment.methodName, payment.amount])).toEqual([["Bank transfer", "24000.00"]]);
    // No approval was needed or invented for the discount or the credit over the limit.
    expect(await db.approval.count()).toBe(0);

    // The sale the stock could not cover: accepted, stock to zero, the rest noted for a manager.
    const third = await db.sale.findFirstOrThrow({ where: { receiptNumber: "IMP-0459" }, include: { lines: true } });
    expect(third.createdAt.getTime()).toBe(moment(day2, 12, 0).getTime());
    expect(third.lines.map((line) => [line.baseQuantity.toFixed(3), line.stockShort.toFixed(3), line.lineCost.toFixed(2)])).toEqual([["40.000", "15.000", "2400.00"]]);
    const exceptions = (await listOfflineExceptions(world.a.as.MANAGER)).rows;
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ kind: "STOCK_SHORT", sale: { receiptNumber: "IMP-0459" } });
    expect(exceptions[0].summary).toBe('40 single of "A Seed Sachet" was sold, but the system held only 25 in Shelf. Count that product and adjust the stock.');
    expect((await getSale(world.a.as.MANAGER, { saleId: third.id })).imported?.exceptions).toHaveLength(1);

    // The customer's account: what he owed before, then the credit sale on its own day.
    const okoro = (await listCustomers(world.a.as.ADMIN)).customers[0];
    expect(okoro.balance).toBe("32500.00");
    const statement = await getCustomerStatement(world.a.as.ADMIN, { customerId: okoro.id });
    expect(statement.lines.map((line) => [line.type, line.amount, line.balanceAfter, line.documentNumber])).toEqual(
      expect.arrayContaining([
        ["OPENING_BALANCE", "12500.00", "12500.00", "IM-000001"],
        ["CREDIT_SALE", "20000.00", "32500.00", "IMP-0458"],
      ]),
    );
    // A repayment pays the debt from before KuchPos first, then this sale.
    await recordRepayment(world.a.as.ACCOUNTANT, { requestId: randomUUID(), customerId: okoro.id, amount: "13000", methodId: world.a.transferMethodId });
    expect((await getCustomer(world.a.as.ADMIN, { customerId: okoro.id })).unpaidSales).toEqual([expect.objectContaining({ receiptNumber: "IMP-0458", outstanding: "19500.00" })]);

    // Reports: the sales are on their own days; the money is in collections.
    const report = await getSalesReport(world.a.as.ADMIN, { from: day0, to: day2, by: "day" });
    expect(report.summary).toMatchObject({ salesCount: 3, beforeDiscount: "73100.00", discounts: "500.00", sales: "72600.00", netSales: "72600.00" });
    expect(report.rows.map((row) => [row.net, row.cost]).sort()).toEqual([["25000.00", "19000.00"], ["3600.00", "2400.00"], ["44000.00", "39100.00"]]);
    expect((await getSalesReport(world.a.as.ADMIN, { from: today, to: today })).summary.salesCount).toBe(0);
    const collections = await getCollectionsReport(world.a.as.ADMIN, { from: day0, to: day2 });
    expect(collections.rows.map((row) => [row.methodName, row.fromSales])).toEqual(expect.arrayContaining([["Cash", "28600.00"], ["Bank transfer", "24000.00"]]));

    // No till ever holds this money: a till opened and closed today expects only its float.
    const till = await openTill(world.a.as.MANAGER, { terminalId: world.a.terminalId, openingFloat: "1000" });
    const closed = await closeTill(world.a.as.MANAGER, { sessionId: till.id, countedCash: "1000" });
    expect(closed).toMatchObject({ expectedCash: "1000.00", difference: "0.00" });

    // On record, and in the activity log.
    expect((await listImports(world.a.as.ADMIN))[0]).toMatchObject({ number: 2, part: "HISTORY", summary: expect.objectContaining({ deliveries: 1, sales: 3, salesTotal: "72600.00" }) });
    expect((await db.activityLog.findFirstOrThrow({ where: { action: "import.history" } })).summary).toBe(
      `Test a.admin brought in green-valley.xlsx (IM-000002): 1 delivery costing ₦41,800.00 and 3 sales worth ₦72,600.00, from ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${day0}T00:00:00Z`))} to ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${day2}T00:00:00Z`))}. 1 product was sold beyond the stock on record — see the exceptions list.`,
    );

    // Selling carries on from where the records leave off.
    await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "0" });
    const sachet = await db.productUnit.findFirstOrThrow({ where: { productId: tomato.id, name: "sachet" } });
    const sale = await postSale(world.a.as.CASHIER, {
      requestId: randomUUID(),
      terminalId: world.a.terminalId,
      expectedTotal: "1000.00",
      payments: [{ methodId: world.a.cashMethodId, amount: "1000.00" }],
      lines: [{ productId: tomato.id, unitId: sachet.id, quantity: "2", unitPrice: "500.00" }],
    });
    expect(sale.receiptNumber).toBe("T1-000001");
  });

  it("cannot bring the same file, the same receipt or the same delivery in twice", async () => {
    const file = await makeWorkbook(history());
    await runHistoryImport(world.a.as.ADMIN, about, file);
    const after = await counts();
    expect((await previewHistoryImport(world.a.as.ADMIN, about, file)).alreadyImported).toMatchObject({ number: 2 });
    expect((await refusal(runHistoryImport(world.a.as.ADMIN, about, file))).message).toMatch(/already brought in as IM-000002/);

    // A later file that repeats one receipt and the delivery beside new ones.
    const later = history();
    later.sales = [later.sales[3], { date: typed(day2), receipt: "0460", code: "TOM-001", unit: "sachet", quantity: "1", price: "500", paidBy: "Cash" }];
    const again = await previewHistoryImport(world.a.as.ADMIN, about, await makeWorkbook(later));
    expect(again.problems.map((problem) => [problem.sheet, problem.row, problem.message])).toEqual([
      ["Deliveries", 4, 'Delivery "D-014" from Agro Supplies Ltd is already in KuchPos, as GR-000002. Take its rows out.'],
      ["Sales", 4, "Receipt 0457 is already in KuchPos, as IMP-0457. Take its rows out."],
    ]);
    expect(await counts()).toEqual(after);

    // Only what is new goes in.
    const fresh = await makeWorkbook({ sales: [later.sales[1]] });
    expect((await runHistoryImport(world.a.as.ADMIN, about, fresh)).number).toBe(3);
    expect(await counts()).toMatchObject({ sales: after.sales + 1, receipts: after.receipts, suppliers: after.suppliers });
  });

  it("reports every problem by sheet and row, and saves nothing while there is one", async () => {
    const before = await counts();
    const tomorrow = shopToday(new Date(Date.now() + DAY));
    const tooEarly = shopToday(new Date(Date.now() - 6 * DAY));
    const sale = (row: Rows[number]): Rows[number] => ({ date: typed(day1), code: "TOM-001", unit: "sachet", quantity: "1", price: "500", paidBy: "Cash", ...row });
    const file = await makeWorkbook({
      deliveries: [
        { date: typed(tooEarly), reference: "D-1", supplier: "Agro", code: "TOM-001", unit: "carton", quantity: "1", cost: "40000" }, // 4: before the start
        { date: typed(day1), reference: "D-2", supplier: "Agro", code: "NOPE", unit: "carton", quantity: "1", cost: "40000" }, // 5: unknown product
        { date: typed(day1), reference: "D-3", supplier: "Agro", code: "TOM-001", unit: "carton", quantity: "1", cost: "40,000" }, // 6: comma
        { date: typed(day1), reference: "D-3", supplier: "Someone Else", code: "TOM-001", unit: "carton", quantity: "1", cost: "40000" }, // 7: two suppliers
        { date: typed(day1), reference: "D-4", supplier: "Agro", code: "TOM-001", unit: "carton", quantity: "0.5", cost: "40000" }, // 8: half a carton
        { date: typed(day1), reference: "", supplier: "Agro", code: "TOM-001", unit: "carton", quantity: "1", cost: "40000" }, // 9: no reference
      ],
      sales: [
        sale({ receipt: "1", date: typed(tomorrow) }), // 4: in the future
        sale({ receipt: "2", unit: "bag" }), // 5: not a unit
        sale({ receipt: "3" }),
        sale({ receipt: "3", date: typed(day2) }), // 7: one receipt, two days
        sale({ receipt: "4" }),
        sale({ receipt: "4", paidBy: "Bank transfer" }), // 9: two ways of paying
        sale({ receipt: "5", paidBy: "Cheque" }), // 10: not a way of paying
        sale({ receipt: "6", customerPhone: "08000000000" }), // 11: unknown customer
        sale({ receipt: "7", onCredit: "100" }), // 12: credit with no customer
        sale({ receipt: "8", onCredit: "501", customerPhone: "08031112222" }), // 13: more credit than the sale
        sale({ receipt: "9", discount: "501" }), // 14: more discount than the sale
        sale({ receipt: "10", time: "25:00" }), // 15: not a time
        sale({ receipt: "11", quantity: "1.5" }), // 16: half a sachet
        sale({ receipt: "12345678901234567" }), // 17: number too long
        sale({ receipt: "12", price: "" }), // 18: no price
      ],
    });
    const preview = await previewHistoryImport(world.a.as.ADMIN, about, file);
    expect(preview.canImport).toBe(false);
    expect(preview.problems.map((problem) => `${problem.sheet} ${problem.row}`)).toEqual([
      "Deliveries 4", "Deliveries 5", "Deliveries 6", "Deliveries 7", "Deliveries 8", "Deliveries 9",
      "Sales 4", "Sales 5", "Sales 7", "Sales 9", "Sales 10", "Sales 11", "Sales 12", "Sales 13", "Sales 14", "Sales 15", "Sales 16", "Sales 17", "Sales 18",
    ]);
    const said = (sheet: string, row: number) => preview.problems.find((problem) => problem.sheet === sheet && problem.row === row)!.message;
    expect(said("Deliveries", 4)).toMatch(/is before the day the records start/);
    expect(said("Deliveries", 5)).toBe('The product code "NOPE" is not in KuchPos. Bring the Products sheet in first (step 2 on this page).');
    expect(said("Deliveries", 7)).toBe('Delivery "D-3" is from "Agro" on row 6 and from "Someone Else" here. Use another reference for another supplier\'s delivery.');
    expect(said("Sales", 4)).toMatch(/is in the future/);
    expect(said("Sales", 5)).toBe('"Tomato Seed Sachet" has no unit called "bag". Its units are: sachet, carton.');
    expect(said("Sales", 9)).toBe('Receipt 4 is paid by "Cash" on row 8 and by "Bank transfer" here. Put one way of paying on every row of a sale.');
    expect(said("Sales", 10)).toBe('"Cheque" is not one of this shop\'s ways of paying. They are: Bank transfer, Cash. Add it in Settings first, or use one of these.');
    expect(said("Sales", 12)).toBe("Receipt 7 has an amount on credit but no customer phone. Credit is always owed by a customer.");
    expect(said("Sales", 13)).toBe("The amount on credit, ₦501.00, is more than receipt 8 comes to (₦500.00).");
    expect(said("Sales", 14)).toBe("The discount of ₦501.00 is more than receipt 9 comes to (₦500.00).");
    expect(said("Sales", 15)).toMatch(/is not a time/);

    expect((await refusal(runHistoryImport(world.a.as.ADMIN, about, file))).message).toBe("Nothing was brought in: the workbook has 19 problems. Correct them in Excel and upload it again.");
    expect(await counts()).toEqual(before);
    // A workbook with only the other three sheets has nothing for this step.
    expect((await refusal(previewHistoryImport(world.a.as.ADMIN, about, await makeWorkbook({ products: [{ code: "X", name: "X", unit: "x", contains: "1" }] })))).message).toMatch(/Nothing to bring in/);
  });

  it("is all or nothing: a failure on the last sale leaves no delivery, sale, debt or record of the import", async () => {
    const file = await makeWorkbook(history());
    const before = await counts();
    const owed = (await listCustomers(world.a.as.ADMIN)).customers[0].balance;
    // The last thing written is the cash payment of the third sale. Make the database refuse a payment of exactly that amount.
    await getDb().$executeRawUnsafe(
      "CREATE TRIGGER `import_test_failure` BEFORE INSERT ON `payment` FOR EACH ROW BEGIN IF NEW.amount = 3600.00 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Simulated failure while importing'; END IF; END",
    );
    await expect(runHistoryImport(world.a.as.ADMIN, about, file)).rejects.toThrow();
    expect(await counts()).toEqual(before);
    expect((await listCustomers(world.a.as.ADMIN)).customers[0].balance).toBe(owed);
    await getDb().$executeRawUnsafe("DROP TRIGGER `import_test_failure`");
    // No number was used up, and the same file can now go in.
    const done = await runHistoryImport(world.a.as.ADMIN, about, file);
    expect(done.number).toBe(2);
    expect((await getDb().sale.findFirstOrThrow({ where: { receiptNumber: "IMP-0457" } })).sequence).toBe(2_000_000_001);
  });

  it("is for the admin and the owner only, and touches no other business", async () => {
    const file = await makeWorkbook(history());
    for (const role of ["MANAGER", "ACCOUNTANT", "CASHIER", "STOREKEEPER"] as const) {
      await expect(previewHistoryImport(world.a.as[role], about, file), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(runHistoryImport(world.a.as[role], about, file), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(runHistoryImport(world.ownerOutside, about, file)).rejects.toBeInstanceOf(ForbiddenError);
    // Business B has no TOM-001 and no such customer: the same file is full of problems there, and saves nothing.
    const inB = await previewHistoryImport(world.b.as.ADMIN, about, file);
    expect(inB.canImport).toBe(false);
    await runHistoryImport(world.ownerInA, about, file);
    const db = getDb();
    expect(await db.sale.count({ where: { businessId: world.b.id } })).toBe(0);
    expect(await db.goodsReceipt.count({ where: { businessId: world.b.id } })).toBe(0);
    expect(await db.stockMovement.count({ where: { businessId: world.b.id } })).toBe(0);
  });
});
