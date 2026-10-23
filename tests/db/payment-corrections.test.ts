import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listActivity } from "@/server/business/activity-log";
import { getDashboard } from "@/server/business/dashboard";
import { correctPayment } from "@/server/business/payment-corrections";
import { createPaymentMethod, setPaymentMethodActive } from "@/server/business/payment-methods";
import { getCollectionsReport, getSalesReport } from "@/server/business/reports";
import { cancelSale, getSale, postSale } from "@/server/business/sales";
import { receiveGoods } from "@/server/business/stock";
import { closeTill, getTillSession, openTill, requestTillCash } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, type World } from "../support/world";

/**
 * Correcting how a sale was paid (C81). The cashier rang up ₦300 as Cash; it was really paid by
 * transfer. The payment row is never changed; a correction is kept beside it, and the till, the
 * reports, "collected today", the receipt and a later cancellation all follow it.
 */

let world: World;
let sessionId: string;

beforeEach(async () => {
  world = await createWorld();
  await receiveGoods(world.a.as.ADMIN, {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.shelfId,
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "20", unitCost: "50" }],
  });
  sessionId = (await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "1000" })).id;
});

afterEach(async () => {
  await expectBalancesMatchMovements();
  await expectCustomerBalancesMatchEntries();
});

/** A cash sale of 3 at ₦100, rung up by the cashier. */
async function cashSale() {
  const sale = await postSale(world.a.as.CASHIER, {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    expectedTotal: "300.00",
    payments: [{ methodId: world.a.cashMethodId, amount: "300.00", tendered: "500.00" }],
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "3", unitPrice: "100.00" }],
  });
  const payment = await getDb().payment.findFirstOrThrow({ where: { saleId: sale.id } });
  return { saleId: sale.id, paymentId: payment.id, receiptNumber: sale.receiptNumber };
}
const correction = (paymentId: string, methodId: string, extra: Record<string, unknown> = {}) => ({
  requestId: randomUUID(),
  paymentId,
  methodId,
  reason: "Customer paid by bank transfer",
  ...extra,
});
const expected = async () => (await getTillSession(world.a.as.MANAGER, { sessionId })).expectedCash;
const fieldErrorsOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).fieldErrors;
};

describe("correcting how a sale was paid", () => {
  it("moves the amount from Cash to the transfer everywhere, keeps the payment as it was, and logs it", async () => {
    const sale = await cashSale();
    const before = await getDb().payment.findUniqueOrThrow({ where: { id: sale.paymentId } });
    expect(await expected()).toBe("1300.00");

    const saved = await correctPayment(world.a.as.MANAGER, correction(sale.paymentId, world.a.transferMethodId, { reference: "TRF-881" }));
    expect(saved).toMatchObject({ saleId: sale.saleId, alreadySaved: false });

    // The payment row is untouched.
    expect(await getDb().payment.findUniqueOrThrow({ where: { id: sale.paymentId } })).toEqual(before);
    // The sale page and receipt: paid by transfer, no cash handed over, the history kept.
    const shown = await getSale(world.a.as.MANAGER, { saleId: sale.saleId });
    expect(shown.payments).toEqual([
      expect.objectContaining({ id: sale.paymentId, kind: "TRANSFER", amount: "300.00", reference: "TRF-881", tendered: null, change: null }),
    ]);
    expect(shown.change).toBe("0.00");
    expect(shown.payments[0].corrections).toEqual([
      expect.objectContaining({ fromMethodName: "Cash", fromKind: "CASH", toKind: "TRANSFER", reason: "Customer paid by bank transfer", correctedByName: "Test a.manager" }),
    ]);
    // The till: the cash it should hold drops by ₦300, and the transfer is listed.
    expect(await expected()).toBe("1000.00");
    const till = await getTillSession(world.a.as.MANAGER, { sessionId });
    expect(till.byMethod.map((entry) => [entry.kind, entry.count, entry.amount])).toEqual([["TRANSFER", 1, "300.00"]]);
    // "Collected today" and the reports.
    expect((await getDashboard(world.a.as.ADMIN)).collectedToday).toEqual({ total: "300.00", cash: "0.00" });
    const collections = await getCollectionsReport(world.a.as.ADMIN);
    expect(collections.rows.map((row) => [row.kind, row.fromSales])).toEqual([["TRANSFER", "300.00"]]);
    expect(collections.cashNet).toBe("0.00");
    const byMethod = await getSalesReport(world.a.as.ADMIN, { by: "method" });
    expect(byMethod.rows.map((row) => [row.label, row.sales])).toEqual([["Bank transfer", "300.00"]]);
    // The activity log says what was entered and what it became.
    expect((await listActivity(world.a.as.ADMIN)).entries[0].summary).toMatch(
      new RegExp(`corrected how receipt ${sale.receiptNumber} was paid: ₦300\\.00 entered as Cash, corrected to Bank transfer\\. Reason: Customer paid by bank transfer`),
    );

    // Sent twice: nothing more happens.
    const again = correction(sale.paymentId, world.a.transferMethodId);
    await correctPayment(world.a.as.MANAGER, again).catch(() => null);
    expect(await getDb().paymentCorrection.count()).toBe(1);
  });

  it("can be corrected again, and the totals follow the latest; a repeat of the same request changes nothing", async () => {
    const sale = await cashSale();
    const pos = await createPaymentMethod(world.a.as.ADMIN, { name: "POS terminal", kind: "POS" });
    const first = correction(sale.paymentId, world.a.transferMethodId);
    await correctPayment(world.a.as.MANAGER, first);
    expect(await correctPayment(world.a.as.MANAGER, first)).toMatchObject({ alreadySaved: true });
    await correctPayment(world.a.as.ADMIN, correction(sale.paymentId, pos.id, { reason: "It was the POS, not a transfer" }));
    let till = await getTillSession(world.a.as.MANAGER, { sessionId });
    expect(till.byMethod.map((entry) => [entry.methodName, entry.count, entry.amount])).toEqual([["POS terminal", 1, "300.00"]]);
    // And back to cash after all: the drawer counts it again.
    await correctPayment(world.a.as.MANAGER, correction(sale.paymentId, world.a.cashMethodId, { reason: "It was cash after all" }));
    expect(await expected()).toBe("1300.00");
    till = await getTillSession(world.a.as.MANAGER, { sessionId });
    expect(till.byMethod.map((entry) => [entry.methodName, entry.count, entry.amount])).toEqual([["Cash", 1, "300.00"]]);
    expect((await getSale(world.a.as.ADMIN, { saleId: sale.saleId })).payments[0].corrections).toHaveLength(3);
  });

  it("refunds a later cancellation the corrected way: nothing comes out of the drawer for a transfer", async () => {
    const sale = await cashSale();
    await correctPayment(world.a.as.MANAGER, correction(sale.paymentId, world.a.transferMethodId));
    await cancelSale(world.a.as.MANAGER, { saleId: sale.saleId, note: "Customer changed their mind" });
    const refund = await getDb().refund.findFirstOrThrow({ where: { saleId: sale.saleId } });
    expect(refund).toMatchObject({ kind: "TRANSFER", methodId: world.a.transferMethodId });
    expect(await expected()).toBe("1000.00");
    // A cancelled sale can no longer be corrected.
    await expect(correctPayment(world.a.as.MANAGER, correction(sale.paymentId, world.a.cashMethodId))).rejects.toThrow(/has been cancelled/);
  });

  it("is refused for the same way of paying, a way taken out of use, without a reason, or by a cashier", async () => {
    const sale = await cashSale();
    expect(await fieldErrorsOf(correctPayment(world.a.as.MANAGER, correction(sale.paymentId, world.a.cashMethodId)))).toEqual({ methodId: "It is already recorded as Cash." });
    await setPaymentMethodActive(world.a.as.ADMIN, { methodId: world.a.transferMethodId, active: false });
    expect(Object.keys(await fieldErrorsOf(correctPayment(world.a.as.MANAGER, correction(sale.paymentId, world.a.transferMethodId))))).toEqual(["methodId"]);
    await setPaymentMethodActive(world.a.as.ADMIN, { methodId: world.a.transferMethodId, active: true });
    expect(Object.keys(await fieldErrorsOf(correctPayment(world.a.as.MANAGER, correction(sale.paymentId, world.a.transferMethodId, { reason: " " }))))).toEqual(["reason"]);
    await expect(correctPayment(world.a.as.CASHIER, correction(sale.paymentId, world.a.transferMethodId))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getSale(world.a.as.CASHIER, { saleId: sale.saleId })).paymentCorrection).toBeNull();
    expect((await getSale(world.a.as.MANAGER, { saleId: sale.saleId })).paymentCorrection?.methods.map((method) => method.id)).toContain(world.a.transferMethodId);
    expect(await getDb().paymentCorrection.count()).toBe(0);
  });

  it("is refused once the till is closed and counted, and when the cash has already left the drawer", async () => {
    const sale = await cashSale();
    // ₦1,300 in the drawer; the manager takes ₦1,100 out: ₦200 left, less than the ₦300 payment.
    await requestTillCash(world.a.as.MANAGER, { requestId: randomUUID(), sessionId, direction: "OUT", amount: "1100", note: "Paid the supplier" });
    await expect(correctPayment(world.a.as.MANAGER, correction(sale.paymentId, world.a.transferMethodId))).rejects.toThrow(/should only hold ₦200\.00/);

    await closeTill(world.a.as.CASHIER, { sessionId, countedCash: "200" });
    await expect(correctPayment(world.a.as.MANAGER, correction(sale.paymentId, world.a.transferMethodId))).rejects.toThrow(/already been closed and counted/);
    expect((await getSale(world.a.as.MANAGER, { saleId: sale.saleId })).paymentCorrection).toBeNull();
    expect(await getDb().paymentCorrection.count()).toBe(0);
  });

  it("cannot be changed or removed in the database", async () => {
    const sale = await cashSale();
    await correctPayment(world.a.as.MANAGER, correction(sale.paymentId, world.a.transferMethodId));
    await expect(getDb().paymentCorrection.updateMany({ data: { reason: "changed" } })).rejects.toThrow();
    await expect(getDb().paymentCorrection.deleteMany()).rejects.toThrow();
  });
});
