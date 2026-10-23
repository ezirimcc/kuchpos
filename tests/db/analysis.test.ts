import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shopToday } from "@/lib/format";
import { getCustomerPurchases, getHomeAnalysis, getProductSales } from "@/server/business/analysis";
import { createProduct, getProduct } from "@/server/business/catalog";
import { createCustomer, listCustomers, setCreditLimit } from "@/server/business/customers";
import { getSalesReport } from "@/server/business/reports";
import { postReturn } from "@/server/business/returns";
import { cancelSale, postSale } from "@/server/business/sales";
import { receiveGoods } from "@/server/business/stock";
import { openTill } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, type World } from "../support/world";

/**
 * Analysis on the home page, per customer and per product (C70), against a morning's trading
 * worked out by hand:
 *
 *   S1  Ada       2 packs of A Seed Sachet (₦1,800) + 1 hoe (₦2,000) = ₦3,800
 *   S2  Bola      3 singles of A Seed Sachet                          = ₦300
 *   S3  walk-in   2 hoes                                              = ₦4,000
 *   S4  Ada       1 pack                                              = ₦900   — cancelled
 *   R1  Ada brings back 1 of the 2 packs of S1                        − ₦900
 *
 * So: hoes ₦6,000; A Seed Sachet 1,800 − 900 + 300 = ₦1,200 (13 singles left sold);
 * Ada ₦2,900, Bola ₦300; the cancelled sale counts nowhere.
 */

let world: World;
let ada: string;
let bola: string;
let hoe: { id: string; unitId: string };
let s1: string;
const today = shopToday();
const day = { from: today, to: today };

beforeEach(async () => {
  world = await createWorld();
  const admin = world.a.as.ADMIN;
  ada = (await createCustomer(admin, { name: "Ada Okafor", phone: "08031234567" })).id;
  bola = (await createCustomer(admin, { name: "Bola Ade", phone: "08055550000" })).id;
  const created = await createProduct(admin, { name: "Hoe", code: "HOE-1", barcode: "", baseUnitName: "piece", allowsFraction: false, taxable: true, baseForSale: true, basePrice: "2000" });
  hoe = { id: created.id, unitId: (await getProduct(admin, { productId: created.id })).product.units[0].id };
  await receiveGoods(world.a.as.STOREKEEPER, {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.shelfId,
    receivedOn: today,
    lines: [
      { productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "10", unitCost: "700" },
      { productId: hoe.id, unitId: hoe.unitId, quantity: "20", unitCost: "1200" },
    ],
  });
  await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "0" });
  const sell = async (total: string, lines: { productId: string; unitId: string; quantity: string; unitPrice: string }[], customerId = "") =>
    postSale(world.a.as.CASHIER, { requestId: randomUUID(), terminalId: world.a.terminalId, expectedTotal: total, payments: [{ methodId: world.a.cashMethodId, amount: total }], customerId, lines });
  const pack = (quantity: string) => ({ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity, unitPrice: "900.00" });
  const single = (quantity: string) => ({ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity, unitPrice: "100.00" });
  const hoes = (quantity: string) => ({ productId: hoe.id, unitId: hoe.unitId, quantity, unitPrice: "2000.00" });

  s1 = (await sell("3800.00", [pack("2"), hoes("1")], ada)).id;
  await sell("300.00", [single("3")], bola);
  await sell("4000.00", [hoes("2")]);
  const s4 = await sell("900.00", [pack("1")], ada);
  await cancelSale(world.a.as.MANAGER, { saleId: s4.id, note: "Rung up twice" });
  const packLine = await getDb().saleLine.findFirstOrThrow({ where: { saleId: s1, unitName: "pack" } });
  await postReturn(world.a.as.MANAGER, {
    requestId: randomUUID(),
    saleId: s1,
    reason: "Wrong variety",
    lines: [{ saleLineId: packLine.id, quantity: "1", disposition: "SHELF" }],
    refundMethodId: world.a.cashMethodId,
    terminalId: world.a.terminalId,
  });
});

afterEach(async () => {
  await expectBalancesMatchMovements();
  await expectCustomerBalancesMatchEntries();
});

describe("the home page's best sellers", () => {
  it("are the top products, categories and customers by net sales — and agree with the sales report and the customers list", async () => {
    const analysis = await getHomeAnalysis(world.a.as.ADMIN, day);
    expect(analysis.period).toMatchObject({ from: today, to: today, days: 1 });
    expect(analysis.products.map((row) => [row.label, row.amount])).toEqual([["Hoe", "6000.00"], ["A Seed Sachet", "1200.00"]]);
    expect(analysis.categories.map((row) => [row.label, row.amount])).toEqual([["No category", "6000.00"], ["Seeds", "1200.00"]]);
    expect(analysis.customers.map((row) => [row.label, row.amount])).toEqual([["Ada Okafor", "2900.00"], ["Bola Ade", "300.00"]]);

    // The same figures, names and order as the sales report and the customers list give.
    const report = await getSalesReport(world.a.as.ADMIN, { ...day, by: "product" });
    expect(analysis.products.map((row) => [row.label, row.amount])).toEqual(report.rows.map((row) => [row.label, row.net]));
    const byCategory = await getSalesReport(world.a.as.ADMIN, { ...day, by: "category" });
    expect(analysis.categories.map((row) => [row.label, row.amount])).toEqual(byCategory.rows.map((row) => [row.label, row.net]));
    const listed = await listCustomers(world.a.as.ADMIN, { ...day, sort: "purchases" });
    expect(analysis.customers.map((row) => [row.label, row.amount])).toEqual(listed.customers.map((customer) => [customer.name, customer.purchases]));
    expect(report.summary.netSales).toBe("7200.00");
    // The owner sees it too; nothing before today.
    expect((await getHomeAnalysis(world.ownerInA, day)).products).toHaveLength(2);
    expect(await getHomeAnalysis(world.a.as.ADMIN, { from: "2026-01-01", to: "2026-01-31" })).toMatchObject({ products: [], categories: [], customers: [] });
  });

  it("show at most five of each", async () => {
    const admin = world.a.as.ADMIN;
    for (let n = 1; n <= 6; n += 1) {
      const { id } = await createCustomer(admin, { name: `Buyer ${n}`, phone: `0809000000${n}` });
      await postSale(world.a.as.CASHIER, {
        requestId: randomUUID(),
        terminalId: world.a.terminalId,
        expectedTotal: `${n * 100}.00`,
        payments: [{ methodId: world.a.cashMethodId, amount: `${n * 100}.00` }],
        customerId: id,
        lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: String(n), unitPrice: "100.00" }],
      });
    }
    const analysis = await getHomeAnalysis(admin, day);
    // Bola and Buyer 3 both spent ₦300; of equals, the name that comes first is kept.
    expect(analysis.customers.map((row) => [row.label, row.amount])).toEqual([["Ada Okafor", "2900.00"], ["Buyer 6", "600.00"], ["Buyer 5", "500.00"], ["Buyer 4", "400.00"], ["Bola Ade", "300.00"]]);
  });

  it("are for admins and owners only", async () => {
    for (const role of ["MANAGER", "ACCOUNTANT", "CASHIER", "STOREKEEPER"] as const) {
      await expect(getHomeAnalysis(world.a.as[role], day), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Business B's admin sees business B: nothing sold there.
    expect((await getHomeAnalysis(world.b.as.ADMIN, day)).products).toEqual([]);
  });
});

describe("what one customer bought", () => {
  it("lists each product with the quantity and amount spent, after returns, and each purchase", async () => {
    const bought = await getCustomerPurchases(world.a.as.ADMIN, { customerId: ada, ...day });
    expect(bought).toMatchObject({ customer: { name: "Ada Okafor" }, salesCount: 1, spent: "2900.00", total: 1 });
    expect(bought.products.map((row) => [row.name, row.quantity, row.unitName, row.amount])).toEqual([
      ["Hoe", "1.000", "piece", "2000.00"],
      // 2 packs = 20 singles, 1 pack came back: 10 singles and ₦900 remain.
      ["A Seed Sachet", "10.000", "single", "900.00"],
    ]);
    expect(bought.sales).toEqual([expect.objectContaining({ id: s1, total: "3800.00", items: 2, onCredit: "0.00", refunded: "900.00" })]);
    // The same figure as the customers list shows for her.
    const listed = (await listCustomers(world.a.as.ADMIN, { ...day, sort: "purchases" })).customers[0];
    expect([listed.name, listed.purchases]).toEqual(["Ada Okafor", bought.spent]);
    expect(await getCustomerPurchases(world.a.as.ACCOUNTANT, { customerId: bola, ...day })).toMatchObject({ salesCount: 1, spent: "300.00" });
    expect(await getCustomerPurchases(world.a.as.ADMIN, { customerId: ada, from: "2026-01-01", to: "2026-01-31" })).toMatchObject({ salesCount: 0, spent: "0.00", products: [], sales: [] });
  });

  it("is not for managers, cashiers or storekeepers, nor for another business", async () => {
    for (const role of ["MANAGER", "CASHIER", "STOREKEEPER"] as const) {
      await expect(getCustomerPurchases(world.a.as[role], { customerId: ada, ...day }), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(getCustomerPurchases(world.b.as.ADMIN, { customerId: ada, ...day })).rejects.toBeInstanceOf(NotFoundError);
    // A manager no longer sees purchases on the customers list, nor sets a credit limit (C70).
    const forManager = await listCustomers(world.a.as.MANAGER, { ...day, sort: "purchases", min: "1000" });
    expect(forManager.showsPurchases).toBe(false);
    expect(forManager.customers.map((customer) => [customer.name, customer.purchases, customer.visits])).toEqual([["Ada Okafor", null, null], ["Bola Ade", null, null]]);
    await expect(setCreditLimit(world.a.as.MANAGER, { customerId: ada, creditLimit: "5000" })).rejects.toBeInstanceOf(ForbiddenError);
    await setCreditLimit(world.a.as.ADMIN, { customerId: ada, creditLimit: "5000" });
  });
});

describe("how one product sold", () => {
  it("gives the line over time, who bought it and each sale of it", async () => {
    const sales = await getProductSales(world.a.as.ADMIN, { productId: world.a.product.id, ...day });
    expect(sales).toMatchObject({ product: { name: "A Seed Sachet", unitName: "single" }, grain: "hour", salesCount: 2, amount: "1200.00", quantity: "13.000" });
    // One day is drawn hour by hour: 24 points, and everything sold sits in them.
    expect(sales.series).toHaveLength(24);
    expect(sales.series.filter((point) => point.amount !== "0.00").map((point) => point.amount)).toEqual(["1200.00"]);
    expect(sales.customers.map((row) => [row.name, row.quantity, row.amount, row.salesCount])).toEqual([
      ["Ada Okafor", "10.000", "900.00", 1],
      ["Bola Ade", "3.000", "300.00", 1],
    ]);
    expect(sales.customers[0].lastSale.id).toBe(s1);
    expect(sales.purchases.map((row) => [row.customerName, row.sold, row.unitName, row.amount]).sort()).toEqual([
      ["Ada Okafor", "2.000", "pack", "900.00"],
      ["Bola Ade", "3.000", "single", "300.00"],
    ]);

    // Sales to nobody in particular are gathered on one line.
    const hoes = await getProductSales(world.a.as.ACCOUNTANT, { productId: hoe.id, ...day });
    expect(hoes.customers.map((row) => [row.customerId === null, row.name, row.amount])).toEqual([
      [true, "Customers not named (walk-in)", "4000.00"],
      [false, "Ada Okafor", "2000.00"],
    ]);

    // A week is drawn day by day, with the days nothing was sold; more than three months, month by month.
    const weekAgo = shopToday(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
    const week = await getProductSales(world.a.as.ADMIN, { productId: hoe.id, from: weekAgo, to: today });
    expect(week.grain).toBe("day");
    expect(week.series.map((point) => point.amount)).toEqual(["0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "6000.00"]);
    const year = await getProductSales(world.a.as.ADMIN, { productId: hoe.id, from: `${today.slice(0, 4)}-01-01`, to: today });
    expect(year.grain).toBe("month");
    expect(year.series).toHaveLength(Number.parseInt(today.slice(5, 7), 10));
    expect(year.series[year.series.length - 1]).toMatchObject({ key: today.slice(0, 7), amount: "6000.00", quantity: "3.000" });
  });

  it("is for those who read the sales report and may open Reports — not managers — and never another business's product", async () => {
    for (const role of ["MANAGER", "CASHIER", "STOREKEEPER"] as const) {
      await expect(getProductSales(world.a.as[role], { productId: hoe.id, ...day }), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(getProductSales(world.b.as.ADMIN, { productId: hoe.id, ...day })).rejects.toBeInstanceOf(NotFoundError);
    // A manager sees the Sales report for the last 7 days only (C82; C70 had closed it).
    expect((await getSalesReport(world.a.as.MANAGER)).limited).toBe(true);
  });
});
