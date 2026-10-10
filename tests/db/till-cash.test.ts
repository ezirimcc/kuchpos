import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "@/server/auth/context";
import { cancelSale, getSale, postSale } from "@/server/business/sales";
import { getBusinessSettings, setReceiptPrinting } from "@/server/business/settings";
import { receiveGoods } from "@/server/business/stock";
import { closeTill, decideTillCash, getTill, getTillSession, listWaitingTillCash, openTill, requestTillCash, withdrawTillCash } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, type World } from "../support/world";

/** Cash put into and taken out of an open till during the day (C64), and the printing setting (C63). */

let world: World;
let sessionId = "";

beforeEach(async () => {
  world = await createWorld();
  await receiveGoods(world.a.as.ADMIN, {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.shelfId,
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "100", unitCost: "50" }],
  });
  sessionId = (await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "1000" })).id;
});

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

const ask = (direction: "IN" | "OUT", amount: string, note = "Banking the morning's cash", as: AppContext = world.a.as.CASHIER, extra: Record<string, unknown> = {}) =>
  requestTillCash(as, { requestId: randomUUID(), sessionId, direction, amount, note, ...extra });
const expected = async () => (await getTillSession(world.a.as.MANAGER, { sessionId })).expectedCash;
const sellForCash = (singles: number) =>
  postSale(world.a.as.CASHIER, {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    expectedTotal: `${singles * 100}.00`,
    payments: [{ methodId: world.a.cashMethodId, amount: `${singles * 100}.00` }],
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: String(singles), unitPrice: "100.00" }],
  });

describe("cash in and cash out of an open till", () => {
  it("a cashier's request waits and changes nothing; once a manager approves it, the till should hold that much more or less", async () => {
    await sellForCash(20); // The drawer should hold 1,000 + 2,000.
    const out = await ask("OUT", "1500");
    const into = await ask("IN", "200", "More change from the office");
    expect(out.status).toBe("WAITING");
    expect(await expected()).toBe("3000.00");

    const waiting = (await listWaitingTillCash(world.a.as.MANAGER)).requests;
    expect(waiting.map((request) => [request.direction, request.amount, request.note, request.requestedByName, request.terminalCode])).toEqual([
      ["OUT", "1500.00", "Banking the morning's cash", "Test a.cashier", "T1"],
      ["IN", "200.00", "More change from the office", "Test a.cashier", "T1"],
    ]);

    await decideTillCash(world.a.as.MANAGER, { cashRequestId: out.id, approve: true, note: "Seen the bank slip" });
    expect(await expected()).toBe("1500.00");
    await decideTillCash(world.a.as.ADMIN, { cashRequestId: into.id, approve: true });
    expect(await expected()).toBe("1700.00");
    expect((await listWaitingTillCash(world.a.as.MANAGER)).requests).toEqual([]);

    const session = await getTillSession(world.a.as.ACCOUNTANT, { sessionId });
    expect(session).toMatchObject({ cashPutIn: "200.00", cashTakenOut: "1500.00", expectedCash: "1700.00" });
    expect(session.cashRequests.map((request) => [request.direction, request.status, request.decidedByName, request.decisionNote])).toEqual([
      ["OUT", "APPROVED", "Test a.manager", "Seen the bank slip"],
      ["IN", "APPROVED", "Test a.admin", null],
    ]);

    // Closing counts it: 1,700 is right.
    const closed = await closeTill(world.a.as.MANAGER, { sessionId, countedCash: "1700" });
    expect(closed).toMatchObject({ expectedCash: "1700.00", difference: "0.00" });
    const actions = (await getDb().activityLog.findMany({ where: { action: { startsWith: "till.cash" } }, orderBy: { createdAt: "asc" } })).map((entry) => entry.action);
    expect(actions).toEqual(["till.cash_requested", "till.cash_requested", "till.cash_approved", "till.cash_approved"]);
  });

  it("a manager's or admin's own counts at once; the cashier is never shown what the till should hold", async () => {
    const recorded = await ask("IN", "500", "Change from the safe", world.a.as.MANAGER);
    expect(recorded.status).toBe("APPROVED");
    expect(await expected()).toBe("1500.00");
    const seenByCashier = await getTill(world.a.as.CASHIER, { terminalId: world.a.terminalId });
    expect(seenByCashier.open).toMatchObject({ expectedCash: null, cashCountsAtOnce: false, cashRequests: [] });
    const own = await ask("OUT", "100", "Bought a broom");
    const mine = (await getTill(world.a.as.CASHIER, { terminalId: world.a.terminalId })).open!.cashRequests;
    expect(mine.map((request) => [request.id, request.status, request.canWithdraw])).toEqual([[own.id, "WAITING", true]]);
    expect((await getTillSession(world.a.as.CASHIER, { sessionId })).cashPutIn).toBeNull();
    expect((await getTill(world.a.as.MANAGER, { terminalId: world.a.terminalId })).open).toMatchObject({ cashCountsAtOnce: true, expectedCash: "1500.00" });
  });

  it("cash out can never be more than the till should hold — when recorded, and when approved", async () => {
    expect((await refusal(ask("OUT", "1000.01", "Too much", world.a.as.MANAGER))).fieldErrors.amount).toBe("The till of T1 should only hold ₦1,000.00.");
    // Two requests that are each fine but together too much: the second cannot be approved.
    const first = await ask("OUT", "700");
    const second = await ask("OUT", "700");
    await decideTillCash(world.a.as.MANAGER, { cashRequestId: first.id, approve: true });
    expect((await refusal(decideTillCash(world.a.as.MANAGER, { cashRequestId: second.id, approve: true }))).message).toBe(
      "Not approved: the till of T1 should only hold ₦300.00, less than the ₦700.00 asked for.",
    );
    // Nothing of the failed approval stayed: it is still waiting, and can be refused.
    expect((await listWaitingTillCash(world.a.as.ADMIN)).requests.map((request) => request.id)).toEqual([second.id]);
    expect(await expected()).toBe("300.00");
    await decideTillCash(world.a.as.MANAGER, { cashRequestId: second.id, approve: false, note: "Not today" });
    expect(await expected()).toBe("300.00");

    // Cash taken out is no longer there to refund a cancelled sale with.
    const sale = await sellForCash(5);
    await ask("OUT", "800", "To the bank", world.a.as.MANAGER);
    expect((await refusal(cancelSale(world.a.as.MANAGER, { saleId: sale.id, note: "Customer changed his mind" }))).message).toMatch(/should only hold ₦0.00/);
    expect((await getSale(world.a.as.MANAGER, { saleId: sale.id })).cancellation).toBeNull();
  });

  it("needs an amount and a note; the same request sent twice is saved once; two answers at once give one", async () => {
    for (const amount of ["", "0", "-5", "1,000", "abc"]) {
      expect((await refusal(ask("OUT", amount))).fieldErrors, amount).toHaveProperty("amount");
    }
    expect((await refusal(ask("OUT", "100", " "))).fieldErrors).toHaveProperty("note");
    expect(await getDb().tillCashRequest.count()).toBe(0);

    const input = { requestId: randomUUID(), sessionId, direction: "OUT", amount: "100", note: "Bought a broom" };
    const [one, two] = await Promise.all([requestTillCash(world.a.as.CASHIER, input), requestTillCash(world.a.as.CASHIER, input)]);
    expect(one.id).toBe(two.id);
    expect(await getDb().tillCashRequest.count()).toBe(1);

    const answers = await Promise.allSettled([
      decideTillCash(world.a.as.MANAGER, { cashRequestId: one.id, approve: true }),
      decideTillCash(world.a.as.ADMIN, { cashRequestId: one.id, approve: true }),
      decideTillCash(world.ownerInA, { cashRequestId: one.id, approve: false }),
    ]);
    expect(answers.filter((answer) => answer.status === "fulfilled")).toHaveLength(1);
    expect(await getDb().tillCashDecision.count()).toBe(1);
    expect((await refusal(decideTillCash(world.a.as.MANAGER, { cashRequestId: one.id, approve: false }))).message).toMatch(/already been answered/);
  });

  it("can be taken back by the person who asked; a till with a request still waiting cannot be closed", async () => {
    const waiting = await ask("OUT", "100", "Bought a broom");
    expect((await refusal(closeTill(world.a.as.CASHIER, { sessionId, countedCash: "1000" }))).message).toMatch(/still waiting for a manager/);
    await expect(withdrawTillCash(world.a.as.MANAGER, { cashRequestId: waiting.id })).rejects.toBeInstanceOf(NotFoundError);
    await withdrawTillCash(world.a.as.CASHIER, { cashRequestId: waiting.id });
    await withdrawTillCash(world.a.as.CASHIER, { cashRequestId: waiting.id });
    expect((await refusal(decideTillCash(world.a.as.MANAGER, { cashRequestId: waiting.id, approve: true }))).message).toMatch(/already been answered/);
    expect(await expected()).toBe("1000.00");

    await closeTill(world.a.as.CASHIER, { sessionId, countedCash: "1000" });
    // Nothing more can be asked of a closed till.
    expect((await refusal(ask("IN", "50", "Late change"))).message).toMatch(/is closed/);
  });

  it("only those who may run a till can ask; only admin, manager and owner answer; business B reaches none of it", async () => {
    for (const role of ["ACCOUNTANT", "STOREKEEPER"] as const) {
      await expect(ask("IN", "100", "Change", world.a.as[role])).rejects.toBeInstanceOf(ForbiddenError);
    }
    const request = await ask("OUT", "100", "Bought a broom");
    // The accountant reviews tills but does not answer cash requests; a cashier never does.
    for (const role of ["ACCOUNTANT", "CASHIER", "STOREKEEPER"] as const) {
      await expect(decideTillCash(world.a.as[role], { cashRequestId: request.id, approve: true }), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listWaitingTillCash(world.a.as[role]), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(decideTillCash(world.b.as.MANAGER, { cashRequestId: request.id, approve: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(requestTillCash(world.b.as.CASHIER, { requestId: randomUUID(), sessionId, direction: "IN", amount: "5", note: "From B" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listWaitingTillCash(world.b.as.ADMIN)).requests).toEqual([]);
    await decideTillCash(world.ownerInA, { cashRequestId: request.id, approve: true });

    const db = getDb();
    await expect(db.tillCashRequest.updateMany({ data: { amount: "1.00" } })).rejects.toThrow();
    await expect(db.tillCashRequest.deleteMany({})).rejects.toThrow();
    await expect(db.tillCashDecision.updateMany({ data: { outcome: "REFUSED" } })).rejects.toThrow();
    await expect(db.tillCashDecision.deleteMany({})).rejects.toThrow();
  });
});

describe("the printing setting", () => {
  it("is on to begin with, is changed by the admin only, travels with every sale, and is logged", async () => {
    expect((await getBusinessSettings(world.a.as.ADMIN)).autoPrintReceipts).toBe(true);
    const sale = await sellForCash(1);
    expect((await getSale(world.a.as.CASHIER, { saleId: sale.id })).business.autoPrintReceipts).toBe(true);

    await expect(setReceiptPrinting(world.a.as.MANAGER, { autoPrint: false })).rejects.toBeInstanceOf(ForbiddenError);
    await setReceiptPrinting(world.a.as.ADMIN, { autoPrint: false });
    await setReceiptPrinting(world.a.as.ADMIN, { autoPrint: false });
    expect((await getBusinessSettings(world.a.as.ADMIN)).autoPrintReceipts).toBe(false);
    expect((await getSale(world.a.as.CASHIER, { saleId: sale.id })).business.autoPrintReceipts).toBe(false);
    // Each business has its own.
    expect((await getBusinessSettings(world.b.as.ADMIN)).autoPrintReceipts).toBe(true);
    const log = await getDb().activityLog.findMany({ where: { action: "settings.receipt_printing_changed" } });
    expect(log.map((entry) => entry.summary)).toEqual(["Test a.admin set receipts to print only when the Print button is pressed."]);
  });
});
