import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomer, recordRepayment, setCreditLimit } from "@/server/business/customers";
import { getOfflineKit } from "@/server/business/offline";
import { exportReport, getCollectionsReport, getCustomerReport, getDebtReport, getSalesReport, getStockMovements, getStockReport } from "@/server/business/reports";
import { getOwnerOverview } from "@/server/platform/overview";
import { postReturn } from "@/server/business/returns";
import { cancelSale, postOfflineSale, postSale } from "@/server/business/sales";
import { receiveGoods } from "@/server/business/stock";
import { openTill } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { toCsv } from "@/lib/csv";
import { shopToday } from "@/lib/format";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, type World } from "../support/world";

/** Reports (M14, C65): every figure is checked against a small day of trading worked out by hand. */

let world: World;
const today = shopToday();
const yesterday = shopToday(new Date(Date.now() - 24 * 60 * 60 * 1000));

async function sell(as: "CASHIER" | "MANAGER", lines: { unit: "pack" | "single"; quantity: string }[], extra: Record<string, unknown>) {
  const saved = await postSale(world.a.as[as], {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    lines: lines.map((line) => ({
      productId: world.a.product.id,
      unitId: line.unit === "pack" ? world.a.product.packUnitId : world.a.product.baseUnitId,
      quantity: line.quantity,
      unitPrice: line.unit === "pack" ? "900.00" : "100.00",
    })),
    ...extra,
  });
  const saleLines = await getDb().saleLine.findMany({ where: { saleId: saved.id }, orderBy: { lineNumber: "asc" } });
  return { ...saved, lineIds: saleLines.map((line) => line.id) };
}

/**
 * One day in business A (stock bought at ₦50 a single; single ₦100, pack of 10 ₦900):
 *  S1 cashier: 1 pack + 2 singles, cash ........................ ₦1,100 (cost 600)
 *  S2 manager: 3 singles less ₦100 discount, bank transfer ...... ₦200   (cost 150)
 *  S3 cashier: 10 singles for Ada, ₦600 on credit + ₦400 cash ... ₦1,000 (cost 500)
 *  S4 cashier: 5 singles, cash — then cancelled ................. left out (₦500 cash in, ₦500 back)
 *  Return on S1: 1 single back on the Shelf, ₦100 cash handed back
 *  Return on S3: 2 singles written off, ₦200 off Ada's debt
 *  Ada repays ₦100 by transfer.
 *  And one sale made without internet YESTERDAY (by the checkout's clock), sent today: 1 single, ₦100 cash.
 */
beforeEach(async () => {
  world = await createWorld();
  await receiveGoods(world.a.as.ADMIN, {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.shelfId,
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "100", unitCost: "50" }],
  });
  await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "1000" });
  const ada = (await createCustomer(world.a.as.CASHIER, { name: "Ada Okafor", phone: "08031234567" })).id;
  await setCreditLimit(world.a.as.ADMIN, { customerId: ada, creditLimit: "50000" });
  const cash = (amount: string) => [{ methodId: world.a.cashMethodId, amount }];

  const s1 = await sell("CASHIER", [{ unit: "pack", quantity: "1" }, { unit: "single", quantity: "2" }], { expectedTotal: "1100.00", payments: cash("1100.00") });
  await sell("MANAGER", [{ unit: "single", quantity: "3" }], {
    expectedTotal: "200.00",
    payments: [{ methodId: world.a.transferMethodId, amount: "200.00" }],
    discount: { amount: "100", reason: "Loyal customer" },
  });
  const s3 = await sell("CASHIER", [{ unit: "single", quantity: "10" }], { expectedTotal: "1000.00", customerId: ada, creditAmount: "600.00", payments: cash("400.00") });
  const s4 = await sell("CASHIER", [{ unit: "single", quantity: "5" }], { expectedTotal: "500.00", payments: cash("500.00") });
  await cancelSale(world.a.as.MANAGER, { saleId: s4.id, note: "Customer changed his mind" });
  const back = (saleId: string, saleLineId: string, quantity: string, disposition: string, extra: Record<string, unknown>) =>
    postReturn(world.a.as.MANAGER, { requestId: randomUUID(), saleId, reason: "Wrong variety", lines: [{ saleLineId, quantity, disposition }], ...extra });
  await back(s1.id, s1.lineIds[1], "1", "SHELF", { refundMethodId: world.a.cashMethodId, terminalId: world.a.terminalId });
  await back(s3.id, s3.lineIds[0], "2", "WRITTEN_OFF", {});
  await recordRepayment(world.a.as.ACCOUNTANT, { requestId: randomUUID(), customerId: ada, amount: "100", methodId: world.a.transferMethodId });
  await postOfflineSale(world.a.as.CASHIER, {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    pass: (await getOfflineKit(world.a.as.CASHIER)).pass,
    receiptNumber: "T1-F000001",
    deviceTime: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    expectedTotal: "100.00",
    payments: cash("100.00"),
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "1", unitPrice: "100.00" }],
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await expectBalancesMatchMovements();
  await expectCustomerBalancesMatchEntries();
});

const day = { from: today, to: today };
const rowsOf = async (by: string, period = day) =>
  (await getSalesReport(world.a.as.ACCOUNTANT, { ...period, by })).rows.map((row) => [row.label, row.salesCount, row.sales, row.refunds, row.net, row.cost, row.profit, row.margin]);

describe("the sales report", () => {
  it("adds up sales, discounts, returns, net sales, cost and profit, leaving cancelled sales out", async () => {
    const report = await getSalesReport(world.a.as.ACCOUNTANT, day);
    expect(report.summary).toEqual({
      salesCount: 3,
      beforeDiscount: "2400.00",
      discounts: "100.00",
      sales: "2300.00",
      returnsCount: 2,
      refunds: "300.00",
      netSales: "2000.00",
      averageSale: "666.67",
      itemsPerSale: "1.3",
      discountRate: "4.2",
      returnRate: "13.0",
      // Cost of what was sold, 1,250, less the single put back on the Shelf (50). The written-off ones stay a cost.
      cost: "1200.00",
      profit: "800.00",
      margin: "40.0",
    });
    expect(report).toMatchObject({ period: { from: today, to: today, days: 1 }, previous: { from: yesterday, to: yesterday, days: 1 }, by: "day", showsCost: true });
    // The period before: only the sale made without internet yesterday.
    expect(report.before).toMatchObject({ salesCount: 1, sales: "100.00", netSales: "100.00", cost: "50.00", profit: "50.00" });
  });

  it("puts a sale made without internet on the day it was made, not the day it arrived", async () => {
    expect(await rowsOf("day", { from: yesterday, to: today })).toEqual([
      [yesterday, 1, "100.00", "0.00", "100.00", "50.00", "50.00", "50.0"],
      [today, 3, "2300.00", "300.00", "2000.00", "1200.00", "800.00", "40.0"],
    ]);
    expect((await getSalesReport(world.a.as.ACCOUNTANT, { from: yesterday, to: yesterday })).summary.salesCount).toBe(1);
  });

  it("breaks the same figures down by cashier, product, category, hour and how it was paid", async () => {
    // A return counts against whoever made the sale.
    expect(await rowsOf("cashier")).toEqual([
      ["Test a.cashier", 2, "2100.00", "300.00", "1800.00", "1050.00", "750.00", "41.7"],
      ["Test a.manager", 1, "200.00", "0.00", "200.00", "150.00", "50.00", "25.0"],
    ]);
    // By product, each line counts for what it really fetched after its share of the discount.
    expect(await rowsOf("product")).toEqual([["A Seed Sachet", 3, "2300.00", "300.00", "2000.00", "1200.00", "800.00", "40.0"]]);
    expect(await rowsOf("category")).toEqual([["Seeds", 3, "2300.00", "300.00", "2000.00", "1200.00", "800.00", "40.0"]]);
    const hours = await rowsOf("hour");
    expect(hours.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(3);
    expect(hours[0][0]).toMatch(/^\d\d:00 – \d\d:59$/);
    // By payment: money and credit, with what went back the same way. No cost here.
    expect(await rowsOf("method")).toEqual([
      ["Cash", 2, "1500.00", "100.00", "1400.00", null, null, null],
      ["On credit (to pay later)", 1, "600.00", "200.00", "400.00", null, null, null],
      ["Bank transfer", 1, "200.00", "0.00", "200.00", null, null, null],
    ]);
    expect((await getSalesReport(world.a.as.ADMIN, { ...day, by: "nonsense" })).by).toBe("day");
  });

  it("covers this month so far when no dates are given, and at most five years", async () => {
    const report = await getSalesReport(world.a.as.ADMIN);
    expect(report.period).toMatchObject({ from: `${today.slice(0, 8)}01`, to: today });
    await expect(getSalesReport(world.a.as.ADMIN, { from: "2020-01-01", to: today })).rejects.toBeInstanceOf(ValidationError);
    // Two years is fine (C69), and the same sales can be read month by month.
    const twoYears = `${Number.parseInt(today.slice(0, 4), 10) - 2}${today.slice(4)}`;
    const long = await getSalesReport(world.a.as.ADMIN, { from: twoYears, to: today, by: "month" });
    const whole = await getSalesReport(world.a.as.ADMIN, { from: twoYears, to: today });
    expect(long.by).toBe("month");
    expect(long.rows.map((row) => row.key)).toEqual([...new Set(whole.rows.map((row) => row.key.slice(0, 7)))]);
    expect(long.summary).toEqual(whole.summary);
    await expect(getSalesReport(world.a.as.ADMIN, { from: today, to: yesterday })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("the collections report", () => {
  it("follows the money: received for sales and against debts, less what was given back, by method", async () => {
    const report = await getCollectionsReport(world.a.as.ACCOUNTANT, day);
    expect(report.rows).toEqual([
      // Cash: S1 1,100 + S3 400 + the cancelled S4 500; given back: S4's 500 and the 100 return.
      { methodName: "Cash", kind: "CASH", fromSales: "2000.00", fromDebts: "0.00", refunded: "600.00", net: "1400.00" },
      { methodName: "Bank transfer", kind: "TRANSFER", fromSales: "200.00", fromDebts: "100.00", refunded: "0.00", net: "300.00" },
    ]);
    expect(report.totals).toEqual({ fromSales: "2200.00", fromDebts: "100.00", refunded: "600.00", net: "1700.00" });
    expect(report.cashNet).toBe("1400.00");
    // Yesterday's offline sale was paid yesterday.
    expect((await getCollectionsReport(world.a.as.ACCOUNTANT, { from: yesterday, to: yesterday })).totals.net).toBe("100.00");
  });
});

describe("the customer debt report", () => {
  it("shows what each customer owes by how long it has been owed", async () => {
    const report = await getDebtReport(world.a.as.ACCOUNTANT);
    // 600 on credit, less 200 for returned goods, less 100 repaid.
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ name: "Ada Okafor", phone: "08031234567", creditLimit: "50000.00", current: "300.00", days31: "0.00", days61: "0.00", older: "0.00", total: "300.00" });
    expect(report.totals).toEqual({ current: "300.00", days31: "0.00", days61: "0.00", older: "0.00", total: "300.00" });

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 45 * 24 * 60 * 60 * 1000 });
    expect((await getDebtReport(world.a.as.ACCOUNTANT)).rows[0]).toMatchObject({ current: "0.00", days31: "300.00", total: "300.00" });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 100 * 24 * 60 * 60 * 1000 });
    expect((await getDebtReport(world.a.as.ACCOUNTANT)).totals).toMatchObject({ older: "300.00", total: "300.00" });
  });
});

describe("the stock movement report", () => {
  it("lists every movement in the period, and can be narrowed by kind, place and product", async () => {
    const all = await getStockMovements(world.a.as.STOREKEEPER, day);
    // 1 delivery; 5 sale lines online + 1 offline; 1 cancellation; 1 return back to the Shelf (the written-off one moves nothing).
    expect(all.total).toBe(9);
    const count = async (type: string) => (await getStockMovements(world.a.as.STOREKEEPER, { ...day, type })).total;
    expect([await count("RECEIPT"), await count("SALE"), await count("SALE_CANCELLATION"), await count("SALE_RETURN")]).toEqual([1, 6, 1, 1]);
    expect(all.rows.at(-1)).toMatchObject({ type: "RECEIPT", quantity: "100.000", productName: "A Seed Sachet", productCode: "A-001", baseUnitName: "single", locationName: "Shelf", userName: "Test a.admin" });
    expect((await getStockMovements(world.a.as.ADMIN, { ...day, location: world.a.storeroomId })).total).toBe(0);
    expect((await getStockMovements(world.a.as.ADMIN, { ...day, search: "RT-000001" })).rows.map((row) => [row.type, row.quantity])).toEqual([["SALE_RETURN", "1.000"]]);
    expect((await getStockMovements(world.a.as.ADMIN, { from: yesterday, to: yesterday })).total).toBe(0);
  });
});

describe("the customer report", () => {
  it("counts new and returning customers, walk-ins apart, and what each customer has been worth", async () => {
    const report = await getCustomerReport(world.a.as.ACCOUNTANT, day);
    expect(report).toMatchObject({
      // Ada bought for the first time today: 1,000, less 200 for what she brought back.
      newCustomers: 1,
      returningCustomers: 0,
      newSales: "800.00",
      returningSales: "0.00",
      // S1 and S2, less the 100 returned from S1.
      walkInCount: 2,
      walkInSales: "1200.00",
      // Nobody with a name bought yesterday, so there is nobody to have come back.
      boughtBefore: 0,
      cameBack: 0,
      retentionRate: null,
      customersEver: 1,
      lifetimeTotal: "800.00",
      averageLifetimeValue: "800.00",
      total: 1,
    });
    expect(report.rows).toEqual([
      expect.objectContaining({ name: "Ada Okafor", phone: "08031234567", periodPurchases: "800.00", periodVisits: 1, lifetimeValue: "800.00", lifetimeVisits: 1 }),
    ]);

    // Looked at tomorrow, Ada is someone who bought in the period before and has not come back yet.
    const tomorrow = shopToday(new Date(Date.now() + 24 * 60 * 60 * 1000));
    expect(await getCustomerReport(world.a.as.ACCOUNTANT, { from: tomorrow, to: tomorrow })).toMatchObject({
      newCustomers: 0,
      returningCustomers: 0,
      boughtBefore: 1,
      cameBack: 0,
      retentionRate: "0.0",
      lifetimeTotal: "800.00",
    });
    // Over yesterday and today together she is still new, and yesterday's walk-in sale is counted.
    expect(await getCustomerReport(world.a.as.ACCOUNTANT, { from: yesterday, to: today })).toMatchObject({ newCustomers: 1, walkInCount: 3, walkInSales: "1300.00" });
  });
});

describe("the stock report", () => {
  it("works out sell-through, days of stock left, shrinkage, stock-outs and — for those who see costs — turnover and stock value", async () => {
    const report = await getStockReport(world.a.as.ACCOUNTANT, day);
    expect(report.rows).toEqual([
      {
        productId: world.a.product.id,
        name: "A Seed Sachet",
        code: "A-001",
        baseUnitName: "single",
        // 100 came in; 12 + 3 + 10 were sold today and 1 yesterday (offline, but it reached the stock today); 1 came back.
        onHand: "75.000",
        onShelf: "75.000",
        atStart: "0.000",
        received: "100.000",
        // Today's sales, 25, less the 3 that came back.
        sold: "22.000",
        sellThrough: "22.0",
        // 75 left at 22 a day.
        daysLeft: "3",
        // The 2 written off when returned.
        lost: "2.000",
      },
    ]);
    expect(report).toMatchObject({
      productsOnSale: 1,
      noneOnShelf: 0,
      noneAnywhere: 0,
      shelfOutRate: "0.0",
      stockOutRate: "0.0",
      stockValueNow: "3750.00",
      stockValueAtStart: "0.00",
      stockValueAtEnd: "3750.00",
      costOfGoodsSold: "1200.00",
      // 1,200 ÷ the average of 0 and 3,750.
      turnover: "0.64",
      // 3,750 ÷ net sales of 2,000.
      stockToSales: "1.88",
      shrinkageCost: "100.00",
      shrinkageRate: "5.0",
    });

    // The storekeeper sees quantities, not money.
    const forStorekeeper = await getStockReport(world.a.as.STOREKEEPER, day);
    expect(forStorekeeper.rows[0]).toMatchObject({ sold: "22.000", daysLeft: "3" });
    expect(forStorekeeper).toMatchObject({ stockValueNow: null, costOfGoodsSold: null, turnover: null, stockToSales: null, shrinkageCost: null, shrinkageRate: null });

    // Business B received nothing and has nothing: its one product is out of stock.
    expect(await getStockReport(world.b.as.ADMIN, day)).toMatchObject({ productsOnSale: 1, noneOnShelf: 1, noneAnywhere: 1, shelfOutRate: "100.0", stockOutRate: "100.0", stockValueNow: "0.00", turnover: null });
    expect((await getStockReport(world.a.as.ADMIN, { ...day, show: "out" })).total).toBe(0);
    expect((await getStockReport(world.b.as.ADMIN, { ...day, show: "out" })).total).toBe(1);
    expect((await getStockReport(world.a.as.ADMIN, { ...day, search: "no such product" })).rows).toEqual([]);
    // Yesterday the stock had not yet arrived.
    expect((await getStockReport(world.a.as.ADMIN, { from: yesterday, to: yesterday })).rows[0]).toMatchObject({ atStart: "0.000", received: "0.000", onHand: "75.000" });
  });
});

describe("the owner's overview", () => {
  it("shows every business on its own row, matching that business's own reports, to owners only", async () => {
    const overview = await getOwnerOverview(world.ownerOutside, day);
    expect(overview.rows).toEqual([
      { businessId: world.a.id, name: "Business A", active: true, salesCount: 3, sales: "2300.00", refunds: "300.00", netSales: "2000.00", collected: "1700.00", owed: "300.00", customersOwing: 1 },
      { businessId: world.b.id, name: "Business B", active: true, salesCount: 0, sales: "0.00", refunds: "0.00", netSales: "0.00", collected: "0.00", owed: "0.00", customersOwing: 0 },
    ]);
    expect(overview.totals).toEqual({ salesCount: 3, sales: "2300.00", refunds: "300.00", netSales: "2000.00", collected: "1700.00", owed: "300.00" });
    // The same figures as business A's own reports.
    const own = await getSalesReport(world.a.as.ADMIN, day);
    expect([overview.rows[0].sales, overview.rows[0].netSales]).toEqual([own.summary.sales, own.summary.netSales]);
    expect(overview.rows[0].collected).toBe((await getCollectionsReport(world.a.as.ADMIN, day)).totals.net);
    // It works with or without a business open, and for nobody but an owner.
    expect((await getOwnerOverview(world.ownerInA, { from: yesterday, to: yesterday })).rows[0]).toMatchObject({ salesCount: 1, netSales: "100.00", collected: "100.00" });
    for (const role of ["ADMIN", "MANAGER", "ACCOUNTANT", "CASHIER", "STOREKEEPER"] as const) {
      await expect(getOwnerOverview(world.a.as[role], day), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(getOwnerOverview(world.ownerOutside, { from: "2020-01-01", to: today })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("who may read and export reports", () => {
  it("each report needs its own right, and exporting needs the right to export as well; business B sees nothing of A", async () => {
    for (const role of ["CASHIER", "STOREKEEPER"] as const) {
      await expect(getSalesReport(world.a.as[role], day), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getCollectionsReport(world.a.as[role], day), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getDebtReport(world.a.as[role]), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getCustomerReport(world.a.as[role], day), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(exportReport(world.a.as[role], { report: "stock-movements", ...day }), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    // A manager reads the sales list but may not open the Reports pages (C70).
    await expect(getSalesReport(world.a.as.MANAGER, day)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getCollectionsReport(world.a.as.MANAGER, day)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getDebtReport(world.a.as.MANAGER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getStockReport(world.a.as.MANAGER, day)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getStockMovements(world.a.as.MANAGER, day)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(exportReport(world.a.as.MANAGER, { report: "sales", ...day })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getStockMovements(world.a.as.CASHIER, day)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getStockReport(world.a.as.CASHIER, day)).rejects.toBeInstanceOf(ForbiddenError);

    expect((await getSalesReport(world.b.as.ADMIN, day)).summary).toMatchObject({ salesCount: 0, sales: "0.00", netSales: "0.00", averageSale: null, margin: null });
    expect((await getCollectionsReport(world.b.as.ADMIN, day)).rows).toEqual([]);
    expect((await getDebtReport(world.b.as.ADMIN)).rows).toEqual([]);
    expect((await getStockMovements(world.b.as.ADMIN, day)).total).toBe(0);
  });

  it("an export holds exactly what the screen shows, as a table a spreadsheet opens safely", async () => {
    const sales = await exportReport(world.a.as.ACCOUNTANT, { report: "sales", ...day, by: "cashier" });
    expect(sales).toEqual({
      filename: `sales-by-cashier_${today}_to_${today}.csv`,
      header: ["Cashier", "Sales (count)", "Sales", "Refunds for returns", "Net sales", "Cost", "Profit", "Margin %"],
      rows: [
        ["Test a.cashier", 2, "2100.00", "300.00", "1800.00", "1050.00", "750.00", "41.7"],
        ["Test a.manager", 1, "200.00", "0.00", "200.00", "150.00", "50.00", "25.0"],
      ],
    });
    expect(toCsv(sales.header, sales.rows).split("\r\n")[1]).toBe("Test a.cashier,2,2100.00,300.00,1800.00,1050.00,750.00,41.7");

    const collections = await exportReport(world.a.as.ACCOUNTANT, { report: "collections", ...day });
    expect(collections.rows.at(-1)).toEqual(["Total", "2200.00", "100.00", "600.00", "1700.00"]);
    const debts = await exportReport(world.a.as.ADMIN, { report: "debts" });
    expect(debts.rows).toEqual([["Ada Okafor", "08031234567", "50000.00", "300.00", "0.00", "0.00", "0.00", "300.00", today]]);
    const movements = await exportReport(world.a.as.ACCOUNTANT, { report: "stock-movements", ...day, type: "SALE_RETURN", page: "7" });
    expect(movements.rows).toHaveLength(1);
    expect(movements.rows[0].slice(1)).toEqual(["A Seed Sachet", "A-001", "Shelf", "SALE_RETURN", "1.000", "single", "RT-000001", "Test a.manager"]);
    const customers = await exportReport(world.a.as.ACCOUNTANT, { report: "customers", ...day });
    expect(customers.rows).toEqual([["Ada Okafor", "08031234567", today, today, "800.00", 1, "800.00", 1]]);
    const stock = await exportReport(world.a.as.ACCOUNTANT, { report: "stock", ...day });
    expect(stock.rows).toEqual([["A Seed Sachet", "A-001", "single", "75.000", "75.000", "0.000", "100.000", "22.000", "22.0", "3", "2.000"]]);
    await expect(exportReport(world.a.as.ADMIN, { report: "everything" })).rejects.toBeInstanceOf(ValidationError);
  });
});
