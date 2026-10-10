import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "@/server/auth/context";
import { approveAtScreen, decideApprovalRequest, getApprovalRequest, listApprovals, listWaitingApprovals, requestApproval } from "@/server/business/approvals";
import { createCustomer, getCustomer, getCustomerStatement, listCustomers, recordRepayment, setCreditLimit } from "@/server/business/customers";
import { getReturn, getReturnOptions, listReturns, postReturn } from "@/server/business/returns";
import { cancelSale, getSale, postSale } from "@/server/business/sales";
import { getBusinessSettings, setReturnDays } from "@/server/business/settings";
import { receiveGoods } from "@/server/business/stock";
import { closeTill, getTillSession, openTill, requestTillCash } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, TEST_PASSWORD, type World } from "../support/world";

/** Returns of goods against a sale (M13, C62). */

let world: World;
let sessionId = "";

beforeEach(async () => {
  await getDb().$executeRawUnsafe("DROP TRIGGER IF EXISTS `return_test_failure`");
  world = await createWorld();
  for (const business of [world.a, world.b]) {
    await receiveGoods(business.as.ADMIN, {
      requestId: randomUUID(),
      supplierId: business.supplierId,
      locationId: business.shelfId,
      lines: [{ productId: business.product.id, unitId: business.product.baseUnitId, quantity: "100", unitCost: "50" }],
    });
  }
  sessionId = (await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "1000" })).id;
  await openTill(world.b.as.CASHIER, { terminalId: world.b.terminalId, openingFloat: "1000" });
});

afterEach(async () => {
  vi.useRealTimers();
  await getDb().$executeRawUnsafe("DROP TRIGGER IF EXISTS `return_test_failure`");
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

const stock = async (locationId = world.a.shelfId) =>
  (await getDb().stockBalance.findFirst({ where: { productId: world.a.product.id, locationId } }))?.quantity.toFixed(3) ?? "0.000";

/** A sale of packs (₦900) and singles (₦100) in business A, paid in cash unless said otherwise. */
async function sell(packs: number, singles: number, extra: Record<string, unknown> = {}) {
  const total = `${packs * 900 + singles * 100}.00`;
  const saved = await postSale(world.a.as.MANAGER, {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    expectedTotal: total,
    payments: [{ methodId: world.a.cashMethodId, amount: total }],
    lines: [
      ...(packs ? [{ productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: String(packs), unitPrice: "900.00" }] : []),
      ...(singles ? [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: String(singles), unitPrice: "100.00" }] : []),
    ],
    ...extra,
  });
  const lines = await getDb().saleLine.findMany({ where: { saleId: saved.id }, orderBy: { lineNumber: "asc" } });
  return { ...saved, lineIds: lines.map((line) => line.id) };
}

type Back = { saleLineId: string; quantity: string; disposition?: "SHELF" | "STOREROOM" | "WRITTEN_OFF" };
function returning(saleId: string, lines: Back[], extra: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    saleId,
    reason: "Wrong variety",
    lines: lines.map((line) => ({ disposition: "SHELF" as const, ...line })),
    refundMethodId: world.a.cashMethodId,
    terminalId: world.a.terminalId,
    ...extra,
  };
}
const takeBack = (saleId: string, lines: Back[], extra: Record<string, unknown> = {}, as: AppContext = world.a.as.MANAGER) =>
  postReturn(as, returning(saleId, lines, extra));

describe("returning goods", () => {
  it("1 of 3 packs comes back: 10 singles are back on the Shelf and one pack is refunded at the price paid; the sale is unchanged and shows the return", async () => {
    const sale = await sell(3, 0);
    expect(await stock()).toBe("70.000");
    const before = JSON.stringify(await getDb().sale.findUniqueOrThrow({ where: { id: sale.id }, include: { lines: true, payments: true } }));

    const back = await takeBack(sale.id, [{ saleLineId: sale.lineIds[0], quantity: "1" }]);
    expect(back).toMatchObject({ number: 1, refundTotal: "900.00", debtReduced: "0.00", refundPaid: "900.00", alreadySaved: false });
    expect(await stock()).toBe("80.000");
    expect(JSON.stringify(await getDb().sale.findUniqueOrThrow({ where: { id: sale.id }, include: { lines: true, payments: true } }))).toBe(before);

    const seen = await getSale(world.a.as.MANAGER, { saleId: sale.id });
    expect(seen.returns.map((entry) => [entry.id, entry.number, entry.refundTotal])).toEqual([[back.id, 1, "900.00"]]);
    expect(seen).toMatchObject({ canReturn: true, canCancel: false });
    const detail = await getReturn(world.a.as.MANAGER, { returnId: back.id });
    expect(detail).toMatchObject({
      number: 1,
      sale: { id: sale.id, receiptNumber: sale.receiptNumber },
      reason: "Wrong variety",
      refundTotal: "900.00",
      refundPaid: "900.00",
      refundMethodName: "Cash",
      createdByName: "Test a.manager",
      approvedByName: "Test a.manager",
      writtenOffCost: "0.00",
    });
    expect(detail.lines).toEqual([
      { lineNumber: 1, productName: "A Seed Sachet", unitName: "pack", quantity: "1.000", refundAmount: "900.00", disposition: "SHELF", locationName: "Shelf" },
    ]);
    const movement = await getDb().stockMovement.findFirstOrThrow({ where: { type: "SALE_RETURN" } });
    expect([movement.quantityDelta.toFixed(3), movement.documentNumber, movement.documentId]).toEqual(["10.000", "RT-000001", back.id]);
    // The goods came back at the cost they left with.
    expect((await getDb().product.findUniqueOrThrow({ where: { id: world.a.product.id } })).averageCost.toFixed(4)).toBe("50.0000");
    // The cash came out of the till.
    expect((await getTillSession(world.a.as.MANAGER, { sessionId })).expectedCash).toBe("2800.00");
    expect((await getDb().activityLog.findFirstOrThrow({ where: { action: "sale.returned" } })).summary).toBe(
      `Test a.manager took back goods from sale ${sale.receiptNumber} (RT-000001): ₦900.00 refunded. Reason: Wrong variety`,
    );
  });

  it("more than was sold, or more than is left after an earlier return, is refused; two at once cannot both take the last ones", async () => {
    const sale = await sell(3, 2);
    const [packs, singles] = sale.lineIds;
    expect((await refusal(takeBack(sale.id, [{ saleLineId: packs, quantity: "4" }]))).fieldErrors["lines.0.quantity"]).toBe(
      'Only 3 pack of "A Seed Sachet" can still come back from this sale.',
    );
    await takeBack(sale.id, [{ saleLineId: packs, quantity: "2" }]);
    expect((await refusal(takeBack(sale.id, [{ saleLineId: packs, quantity: "2" }]))).fieldErrors).toHaveProperty("lines.0.quantity");

    // One pack is left. Three people return it at the same instant: exactly one succeeds.
    const attempts = await Promise.allSettled([1, 2, 3].map(() => takeBack(sale.id, [{ saleLineId: packs, quantity: "1" }])));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect((await refusal(takeBack(sale.id, [{ saleLineId: packs, quantity: "1" }]))).fieldErrors["lines.0.quantity"]).toBe(
      'All of "A Seed Sachet" on this sale has already been returned.',
    );
    expect(await getDb().saleReturn.count()).toBe(2);
    expect(await stock()).toBe("98.000");

    for (const quantity of ["0", "-1", "abc", "", "1.5"]) {
      expect((await refusal(takeBack(sale.id, [{ saleLineId: singles, quantity }]))).fieldErrors, quantity).toHaveProperty("lines.0.quantity");
    }
    // A line of another sale, the same line twice, no lines, no reason.
    const other = await sell(0, 1);
    expect((await refusal(takeBack(sale.id, [{ saleLineId: other.lineIds[0], quantity: "1" }]))).fieldErrors).toHaveProperty("lines.0.quantity");
    expect((await refusal(takeBack(sale.id, [{ saleLineId: singles, quantity: "1" }, { saleLineId: singles, quantity: "1" }]))).fieldErrors).toHaveProperty("lines.1.quantity");
    expect((await refusal(takeBack(sale.id, []))).fieldErrors).toHaveProperty("lines");
    expect((await refusal(takeBack(sale.id, [{ saleLineId: singles, quantity: "1" }], { reason: " " }))).fieldErrors).toHaveProperty("reason");
    expect(await getDb().saleReturn.count()).toBe(2);
  });

  it("the same return sent twice is saved once; a failure halfway leaves nothing behind", async () => {
    const sale = await sell(0, 5);
    const input = returning(sale.id, [{ saleLineId: sale.lineIds[0], quantity: "2" }]);
    await getDb().$executeRawUnsafe(
      "CREATE TRIGGER `return_test_failure` BEFORE INSERT ON `approval_use` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Simulated failure while saving'",
    );
    await expect(postReturn(world.a.as.MANAGER, input)).rejects.toThrow();
    expect(await getDb().saleReturn.count()).toBe(0);
    expect(await getDb().saleReturnLine.count()).toBe(0);
    expect(await stock()).toBe("95.000");
    await getDb().$executeRawUnsafe("DROP TRIGGER `return_test_failure`");

    const [one, two] = await Promise.all([postReturn(world.a.as.MANAGER, input), postReturn(world.a.as.MANAGER, input)]);
    expect(one.id).toBe(two.id);
    // The number was not used up by the failure.
    expect(one.number).toBe(1);
    expect((await postReturn(world.a.as.MANAGER, input)).alreadySaved).toBe(true);
    expect(await getDb().saleReturn.count()).toBe(1);
    expect(await stock()).toBe("97.000");
  });

  it("damaged goods are written off: nothing goes back into stock and the loss is recorded; goods can also go to the Storeroom", async () => {
    const sale = await sell(1, 4);
    const [packs, singles] = sale.lineIds;
    const back = await takeBack(sale.id, [
      { saleLineId: packs, quantity: "1", disposition: "WRITTEN_OFF" },
      { saleLineId: singles, quantity: "3", disposition: "STOREROOM" },
    ]);
    expect(back.refundTotal).toBe("1200.00");
    expect(await stock()).toBe("86.000");
    expect(await stock(world.a.storeroomId)).toBe("3.000");
    const row = await getDb().saleReturn.findUniqueOrThrow({ where: { id: back.id } });
    expect([row.restockedCost.toFixed(2), row.writtenOffCost.toFixed(2)]).toEqual(["150.00", "500.00"]);
    expect(await getDb().stockMovement.count({ where: { type: "SALE_RETURN" } })).toBe(1);
    const detail = await getReturn(world.a.as.ADMIN, { returnId: back.id });
    expect(detail.lines.map((line) => [line.disposition, line.locationName])).toEqual([
      ["WRITTEN_OFF", null],
      ["STOREROOM", "Storeroom"],
    ]);
    expect((await listReturns(world.a.as.ACCOUNTANT)).returns[0]).toMatchObject({ hasWriteOff: true, refundTotal: "1200.00" });
  });

  it("refunds what was actually paid after a discount, to the kobo, however the goods come back", async () => {
    // 3 singles (₦300) with ₦100 off: ₦200 was paid for them, 66.67 each — which does not divide.
    const sale = await sell(0, 3, { expectedTotal: "200.00", payments: [{ methodId: world.a.cashMethodId, amount: "200.00" }], discount: { amount: "100", reason: "Loyal customer" } });
    const line = sale.lineIds[0];
    const refunds = [];
    for (let time = 0; time < 3; time += 1) refunds.push((await takeBack(sale.id, [{ saleLineId: line, quantity: "1" }])).refundTotal);
    expect(refunds).toEqual(["66.67", "66.67", "66.66"]);
    expect((await getReturnOptions(world.a.as.MANAGER, { saleId: sale.id })).lines[0]).toMatchObject({ sold: "3.000", returned: "3.000", returnable: "0.000", paid: "200.00", refunded: "200.00" });
  });
});

describe("refunding", () => {
  it("cash comes out of an open till that holds enough; a transfer needs no till; nothing handed back needs no method", async () => {
    const sale = await sell(2, 0); // The drawer should hold 1,000 + 1,800.
    const line = sale.lineIds[0];
    await requestTillCash(world.a.as.MANAGER, { requestId: randomUUID(), sessionId, direction: "OUT", amount: "2500", note: "To the bank" });
    expect((await refusal(takeBack(sale.id, [{ saleLineId: line, quantity: "1" }]))).fieldErrors.terminalId).toBe(
      "₦900.00 in cash has to be given back, but the till of T1 should only hold ₦300.00.",
    );
    expect((await refusal(takeBack(sale.id, [{ saleLineId: line, quantity: "1" }], { refundMethodId: "" }))).fieldErrors.refundMethodId).toMatch(/Choose how the ₦900.00 is handed back/);
    expect((await refusal(takeBack(sale.id, [{ saleLineId: line, quantity: "1" }], { terminalId: "" }))).fieldErrors).toHaveProperty("terminalId");

    const byTransfer = await takeBack(sale.id, [{ saleLineId: line, quantity: "1" }], { refundMethodId: world.a.transferMethodId, refundReference: "TRF-778", terminalId: "" });
    expect(await getReturn(world.a.as.MANAGER, { returnId: byTransfer.id })).toMatchObject({ refundMethodName: "Bank transfer", refundReference: "TRF-778" });
    expect((await getTillSession(world.a.as.MANAGER, { sessionId })).expectedCash).toBe("300.00");

    // With the till closed, cash cannot be handed back.
    await closeTill(world.a.as.MANAGER, { sessionId, countedCash: "300" });
    expect((await refusal(takeBack(sale.id, [{ saleLineId: line, quantity: "1" }]))).fieldErrors.terminalId).toBe("The till of T1 is not open, and the cash has to come out of it.");
    expect(await getDb().saleReturn.count()).toBe(1);
  });

  it("a credit sale's refund comes off what is still owed on that sale first; only the rest is handed back", async () => {
    const ada = (await createCustomer(world.a.as.CASHIER, { name: "Ada Okafor", phone: "08031234567" })).id;
    await setCreditLimit(world.a.as.MANAGER, { customerId: ada, creditLimit: "50000" });
    // ₦2,700 of goods: ₦2,000 on credit, ₦700 in cash. Then ₦1,500 of the debt is repaid.
    const sale = await sell(3, 0, { customerId: ada, creditAmount: "2000.00", payments: [{ methodId: world.a.cashMethodId, amount: "700.00" }] });
    await recordRepayment(world.a.as.ACCOUNTANT, { requestId: randomUUID(), customerId: ada, amount: "1500", methodId: world.a.transferMethodId });
    expect((await getReturnOptions(world.a.as.MANAGER, { saleId: sale.id })).owedOnSale).toBe("500.00");

    // One pack back (₦900): ₦500 off the debt, ₦400 handed back.
    const back = await takeBack(sale.id, [{ saleLineId: sale.lineIds[0], quantity: "1" }]);
    expect(back).toMatchObject({ refundTotal: "900.00", debtReduced: "500.00", refundPaid: "400.00" });
    expect((await getCustomer(world.a.as.ADMIN, { customerId: ada })).balance).toBe("0.00");
    const statement = await getCustomerStatement(world.a.as.ADMIN, { customerId: ada });
    expect(statement.lines[0]).toMatchObject({ type: "SALE_RETURN", amount: "-500.00", balanceAfter: "0.00", documentNumber: "RT-000001" });
    expect((await getCustomer(world.a.as.ADMIN, { customerId: ada })).unpaidSales).toEqual([]);

    // Nothing is owed on it any more: the next pack is handed back in full.
    expect(await takeBack(sale.id, [{ saleLineId: sale.lineIds[0], quantity: "1" }])).toMatchObject({ debtReduced: "0.00", refundPaid: "900.00" });
    // What came back is not a purchase.
    expect((await listCustomers(world.a.as.MANAGER)).customers[0]).toMatchObject({ purchases: "900.00", visits: 1 });
    // A debt wholly covered by the refund needs no way of handing money back.
    const second = await sell(0, 2, { customerId: ada, creditAmount: "200.00", payments: [] });
    expect(await takeBack(second.id, [{ saleLineId: second.lineIds[0], quantity: "1" }], { refundMethodId: "", terminalId: "" })).toMatchObject({ debtReduced: "100.00", refundPaid: "0.00" });
    expect((await getCustomer(world.a.as.ADMIN, { customerId: ada })).balance).toBe("100.00");
  });
});

describe("when goods may be returned", () => {
  it("within the days the admin allows (7 to begin with; 0 for no limit); never from a cancelled sale; a sale with a return cannot be cancelled", async () => {
    expect((await getBusinessSettings(world.a.as.ADMIN)).returnDays).toBe(7);
    const sale = await sell(0, 5);
    const line = sale.lineIds[0];

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 8 * 24 * 60 * 60 * 1000 });
    expect((await refusal(takeBack(sale.id, [{ saleLineId: line, quantity: "1" }], { refundMethodId: world.a.transferMethodId }))).message).toMatch(/is too old: its goods could be returned until/);
    expect((await getReturnOptions(world.a.as.MANAGER, { saleId: sale.id })).blocked).toMatch(/too old/);
    await expect(setReturnDays(world.a.as.MANAGER, { days: "30" })).rejects.toBeInstanceOf(ForbiddenError);
    for (const days of ["-1", "abc", "3651", "1.5", ""]) {
      expect((await refusal(setReturnDays(world.a.as.ADMIN, { days }))).fieldErrors, days).toHaveProperty("days");
    }
    await setReturnDays(world.a.as.ADMIN, { days: "30" });
    await takeBack(sale.id, [{ saleLineId: line, quantity: "1" }], { refundMethodId: world.a.transferMethodId });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 400 * 24 * 60 * 60 * 1000 });
    expect((await refusal(takeBack(sale.id, [{ saleLineId: line, quantity: "1" }], { refundMethodId: world.a.transferMethodId }))).message).toMatch(/too old/);
    await setReturnDays(world.a.as.ADMIN, { days: "0" });
    await takeBack(sale.id, [{ saleLineId: line, quantity: "1" }], { refundMethodId: world.a.transferMethodId });
    vi.useRealTimers();
    expect((await getDb().activityLog.findMany({ where: { action: "settings.return_days_changed" }, orderBy: { createdAt: "asc" } })).map((entry) => entry.summary)).toEqual([
      "Test a.admin changed the days allowed for a return from 7 to 30.",
      "Test a.admin changed the days allowed for a return from 30 to no limit.",
    ]);

    // Part of it has come back, so it can no longer be cancelled whole.
    expect((await refusal(cancelSale(world.a.as.MANAGER, { saleId: sale.id, note: "Customer changed his mind" }))).message).toMatch(/have already been returned/);
    const cancelled = await sell(0, 2);
    await cancelSale(world.a.as.MANAGER, { saleId: cancelled.id, note: "Customer changed his mind" });
    expect((await refusal(takeBack(cancelled.id, [{ saleLineId: cancelled.lineIds[0], quantity: "1" }]))).message).toMatch(/was cancelled, so nothing of it can be returned/);
    expect((await getReturnOptions(world.a.as.MANAGER, { saleId: cancelled.id })).blocked).toMatch(/cancelled/);
  });
});

describe("who may return goods", () => {
  it("a cashier needs a manager's approval — at the screen or sent to the manager — for exactly that return; a manager or admin needs nobody", async () => {
    const sale = await sell(2, 0);
    const line = sale.lineIds[0];
    const wanted = returning(sale.id, [{ saleLineId: line, quantity: "1" }]);
    const asCashier = world.a.as.CASHIER;

    expect((await getReturnOptions(asCashier, { receiptNumber: sale.receiptNumber })).needsApproval).toBe(true);
    expect((await refusal(postReturn(asCashier, wanted))).fieldErrors.approvalId).toBe("A manager or admin must approve this return before it can be saved.");

    // The cashier's own password is not enough; another business's manager is not either.
    for (const username of ["a.cashier", "b.manager", "a.accountant"]) {
      expect((await refusal(approveAtScreen(asCashier, { kind: "RETURN", saleRequestId: wanted.requestId, return: wanted, username, password: TEST_PASSWORD }))).fieldErrors, username).toHaveProperty("password");
    }
    const given = await approveAtScreen(asCashier, { kind: "RETURN", saleRequestId: wanted.requestId, return: wanted, username: "a.manager", password: TEST_PASSWORD });
    expect(given.approvedByName).toBe("Test a.manager");

    // Changed after approval — more goods, another place for them, another sale — it no longer fits.
    for (const changed of [
      { ...wanted, lines: [{ ...wanted.lines[0], quantity: "2" }] },
      { ...wanted, lines: [{ ...wanted.lines[0], disposition: "WRITTEN_OFF" as const }] },
      { ...wanted, requestId: randomUUID() },
    ]) {
      expect((await refusal(postReturn(asCashier, { ...changed, approvalId: given.approvalId }))).fieldErrors.approvalId).toMatch(/changed after it was approved|could not be found/);
    }
    const saved = await postReturn(asCashier, { ...wanted, approvalId: given.approvalId });
    expect(await getReturn(asCashier, { returnId: saved.id })).toMatchObject({ createdByName: "Test a.cashier", approvedByName: "Test a.manager" });
    // An approval is spent once.
    expect((await refusal(postReturn(asCashier, { ...returning(sale.id, [{ saleLineId: line, quantity: "1" }]), approvalId: given.approvalId }))).fieldErrors).toHaveProperty("approvalId");

    // Sent to the manager's own computer instead.
    const next = returning(sale.id, [{ saleLineId: line, quantity: "1", disposition: "WRITTEN_OFF" }], { reason: "Pack was torn" });
    const { requestId } = await requestApproval(asCashier, { kind: "RETURN", saleRequestId: next.requestId, return: next });
    const [waiting] = (await listWaitingApprovals(world.a.as.ADMIN)).requests;
    expect(waiting).toMatchObject({
      kind: "RETURN",
      basis: "900.00",
      reason: "Pack was torn",
      requestedByName: "Test a.cashier",
      details: { returnOf: sale.receiptNumber, subtotal: "900.00", lines: [{ productName: "A Seed Sachet (damaged — written off)", quantity: "1.000", unitName: "pack", lineTotal: "900.00" }] },
    });
    await decideApprovalRequest(world.a.as.ADMIN, { requestId, approve: true });
    const answer = (await getApprovalRequest(asCashier, { requestId })) as { approvalId: string };
    await postReturn(asCashier, { ...next, approvalId: answer.approvalId });

    // All three are on the approvals report, the manager's own included.
    const own = await sell(0, 1);
    await takeBack(own.id, [{ saleLineId: own.lineIds[0], quantity: "1" }]);
    const report = await listApprovals(world.a.as.ACCOUNTANT, { kind: "RETURN" });
    expect(report.rows.map((row) => [row.requestedByName, row.approvedByName, row.ownSale, row.remote, row.sale?.receiptNumber]).reverse()).toEqual([
      ["Test a.cashier", "Test a.manager", false, false, sale.receiptNumber],
      ["Test a.cashier", "Test a.admin", false, true, sale.receiptNumber],
      ["Test a.manager", "Test a.manager", true, false, own.receiptNumber],
    ]);
    expect(report.discountTotal).toBe("0.00");
  });

  it("others may not; business B reaches nothing of A's; returns cannot be changed or removed in the database", async () => {
    const sale = await sell(0, 3);
    const back = await takeBack(sale.id, [{ saleLineId: sale.lineIds[0], quantity: "1" }]);
    for (const role of ["ACCOUNTANT", "STOREKEEPER"] as const) {
      await expect(takeBack(sale.id, [{ saleLineId: sale.lineIds[0], quantity: "1" }], {}, world.a.as[role]), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getReturnOptions(world.a.as[role], { saleId: sale.id }), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(listReturns(world.a.as.STOREKEEPER)).rejects.toBeInstanceOf(ForbiddenError);
    // The accountant reads returns; a cashier sees only those they entered.
    expect((await listReturns(world.a.as.ACCOUNTANT)).returns).toHaveLength(1);
    expect(await listReturns(world.a.as.CASHIER)).toMatchObject({ ownOnly: true, returns: [] });
    await expect(getReturn(world.a.as.CASHIER, { returnId: back.id })).rejects.toBeInstanceOf(NotFoundError);
    expect(await listReturns(world.a.as.MANAGER, { search: sale.receiptNumber })).toMatchObject({ total: 1, sumOfRefunds: "100.00" });
    expect((await listReturns(world.a.as.MANAGER, { search: "no such thing" })).returns).toEqual([]);

    await expect(getReturnOptions(world.b.as.MANAGER, { saleId: sale.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getReturnOptions(world.b.as.MANAGER, { receiptNumber: sale.receiptNumber })).rejects.toBeInstanceOf(NotFoundError);
    await expect(postReturn(world.b.as.MANAGER, { ...returning(sale.id, [{ saleLineId: sale.lineIds[0], quantity: "1" }]), refundMethodId: world.b.cashMethodId, terminalId: world.b.terminalId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getReturn(world.b.as.ADMIN, { returnId: back.id })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listReturns(world.b.as.ADMIN)).returns).toEqual([]);

    const db = getDb();
    await expect(db.saleReturn.updateMany({ data: { reason: "x" } })).rejects.toThrow();
    await expect(db.saleReturn.deleteMany({})).rejects.toThrow();
    await expect(db.saleReturnLine.updateMany({ data: { productName: "x" } })).rejects.toThrow();
    await expect(db.saleReturnLine.deleteMany({})).rejects.toThrow();
  });
});
