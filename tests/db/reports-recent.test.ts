import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { shopToday } from "@/lib/format";
import { exportReport, getCollectionsReport, getDebtReport, getSalesReport } from "@/server/business/reports";
import { postSale } from "@/server/business/sales";
import { receiveGoods } from "@/server/business/stock";
import { openTill } from "@/server/business/till";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { createWorld, type World } from "../support/world";

/**
 * A manager sees the Sales and Collections reports for the last 7 days only (C82): any period
 * inside them, no comparison with the period before, no export, and none of the other reports.
 */

let world: World;
const today = shopToday();
const daysAgo = (count: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) - count * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

beforeEach(async () => {
  world = await createWorld();
  await receiveGoods(world.a.as.ADMIN, {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.shelfId,
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "5", unitCost: "50" }],
  });
  await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "0" });
  await postSale(world.a.as.CASHIER, {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    expectedTotal: "200.00",
    payments: [{ methodId: world.a.cashMethodId, amount: "200.00" }],
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "2", unitPrice: "100.00" }],
  });
});

describe("a manager's view of the reports", () => {
  it("opens on the last 7 days, without the period before, and accepts any period inside them", async () => {
    const sales = await getSalesReport(world.a.as.MANAGER);
    expect(sales).toMatchObject({ limited: true, period: { from: daysAgo(6), to: today, days: 7 }, previous: null, before: null });
    expect(sales.summary.netSales).toBe("200.00");
    expect((await getSalesReport(world.a.as.MANAGER, { from: today, to: today, by: "method" })).rows.map((row) => row.sales)).toEqual(["200.00"]);
    const collections = await getCollectionsReport(world.a.as.MANAGER, { from: daysAgo(1), to: today });
    expect(collections).toMatchObject({ limited: true, period: { from: daysAgo(1), to: today }, cashNet: "200.00" });
  });

  it("refuses a period reaching further back, other reports and exports", async () => {
    await expect(getSalesReport(world.a.as.MANAGER, { from: daysAgo(7), to: today })).rejects.toThrow(/last 7 days only/);
    await expect(getCollectionsReport(world.a.as.MANAGER, { from: `${today.slice(0, 8)}01`, to: daysAgo(10) })).rejects.toBeInstanceOf(ValidationError);
    await expect(exportReport(world.a.as.MANAGER, { report: "sales" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getDebtReport(world.a.as.MANAGER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getSalesReport(world.a.as.CASHIER)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("leaves those who open the Reports pages unlimited, with the comparison", async () => {
    const report = await getSalesReport(world.a.as.ACCOUNTANT, { from: daysAgo(40), to: today });
    expect(report.limited).toBe(false);
    expect(report.previous).not.toBeNull();
    expect((await getSalesReport(world.a.as.ADMIN)).before).not.toBeNull();
  });
});
