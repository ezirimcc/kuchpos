import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaymentMethod, listPaymentMethods, renamePaymentMethod, setPaymentMethodActive } from "@/server/business/payment-methods";
import { getCheckoutCatalogue, getSale, postSale } from "@/server/business/sales";
import { createTerminal } from "@/server/business/setup";
import { receiveGoods } from "@/server/business/stock";
import { closeTill, getTill, getTillSession, listTillSessions, openTill, recountTill } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, type World } from "../support/world";

/** Payment methods managed by the admin, split payments, and till sessions. */

let world: World;

beforeEach(async () => {
  world = await createWorld();
  // 500 singles at ₦100 each on the Shelf of each business.
  for (const business of [world.a, world.b]) {
    await receiveGoods(business.as.ADMIN, {
      requestId: randomUUID(),
      supplierId: business.supplierId,
      locationId: business.shelfId,
      lines: [{ productId: business.product.id, unitId: business.product.baseUnitId, quantity: "500", unitCost: "50" }],
    });
  }
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

type Part = { methodId: string; amount: string; tendered?: string; reference?: string };

/** A sale of `singles` at ₦100 each in business A, paid as given. */
function sale(singles: number, payments: Part[], extra: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    expectedTotal: `${singles * 100}.00`,
    payments,
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: String(singles), unitPrice: "100.00" }],
    ...extra,
  };
}
const cash = (amount: string, tendered?: string): Part => ({ methodId: world.a.cashMethodId, amount, ...(tendered ? { tendered } : {}) });
const transfer = (amount: string, reference?: string): Part => ({ methodId: world.a.transferMethodId, amount, ...(reference ? { reference } : {}) });

const openA = (float = "5000", as = world.a.as.CASHIER) => openTill(as, { terminalId: world.a.terminalId, openingFloat: float });

async function onShelf(): Promise<string> {
  const balance = await getDb().stockBalance.findUniqueOrThrow({ where: { productId_locationId: { productId: world.a.product.id, locationId: world.a.shelfId } } });
  return balance.quantity.toFixed(3);
}

describe("payment methods", () => {
  it("every business starts with Cash, and the admin can add, rename and switch off others", async () => {
    const admin = world.a.as.ADMIN;
    const pos = await createPaymentMethod(admin, { name: "POS – Moniepoint", kind: "POS" });
    await createPaymentMethod(admin, { name: "Transfer – GTBank", kind: "TRANSFER" });
    await renamePaymentMethod(admin, { methodId: world.a.transferMethodId, name: "Transfer – Access" });
    await setPaymentMethodActive(admin, { methodId: pos.id, active: false });

    expect((await listPaymentMethods(admin)).map((method) => [method.name, method.kind, method.builtIn, method.active])).toEqual([
      ["Cash", "CASH", true, true],
      ["POS – Moniepoint", "POS", false, false],
      ["Transfer – Access", "TRANSFER", false, true],
      ["Transfer – GTBank", "TRANSFER", false, true],
    ]);
    // The checkout offers only what is switched on, Cash first.
    expect((await getCheckoutCatalogue(world.a.as.CASHIER)).paymentMethods.map((method) => method.name)).toEqual(["Cash", "Transfer – Access", "Transfer – GTBank"]);
    // Business B is untouched.
    expect((await listPaymentMethods(world.b.as.ADMIN)).map((method) => method.name)).toEqual(["Cash", "Bank transfer"]);

    const actions = (await getDb().activityLog.findMany({ where: { action: { startsWith: "payment_method." } }, orderBy: { createdAt: "asc" } })).map((entry) => entry.action);
    expect(actions).toEqual(["payment_method.created", "payment_method.created", "payment_method.renamed", "payment_method.deactivated"]);

    await setPaymentMethodActive(admin, { methodId: pos.id, active: true });
    expect((await getCheckoutCatalogue(world.a.as.CASHIER)).paymentMethods).toHaveLength(4);
  });

  it("refuses a name already in use, a bad name or kind, and switching off Cash", async () => {
    const admin = world.a.as.ADMIN;
    expect((await refusal(createPaymentMethod(admin, { name: "bank TRANSFER", kind: "TRANSFER" }))).fieldErrors.name).toMatch(/already has a payment method/);
    expect((await refusal(renamePaymentMethod(admin, { methodId: world.a.transferMethodId, name: "Cash" }))).fieldErrors.name).toMatch(/already has/);
    expect((await refusal(createPaymentMethod(admin, { name: "X", kind: "POS" }))).fieldErrors).toHaveProperty("name");
    expect((await refusal(createPaymentMethod(admin, { name: "Cheque", kind: "CHEQUE" }))).fieldErrors).toHaveProperty("kind");
    expect((await refusal(setPaymentMethodActive(admin, { methodId: world.a.cashMethodId, active: false }))).message).toMatch(/Cash is always available/);
    // The same name is fine in another business.
    await createPaymentMethod(world.b.as.ADMIN, { name: "POS – Moniepoint", kind: "POS" });
    await createPaymentMethod(admin, { name: "POS – Moniepoint", kind: "POS" });
  });

  it("only the admin and owner manage them; a method is never deleted and never changes kind, even in the database", async () => {
    for (const role of ["MANAGER", "ACCOUNTANT", "CASHIER", "STOREKEEPER"] as const) {
      await expect(createPaymentMethod(world.a.as[role], { name: "Sneaky", kind: "CASH" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listPaymentMethods(world.a.as[role])).rejects.toBeInstanceOf(ForbiddenError);
    }
    await createPaymentMethod(world.ownerInA, { name: "Transfer – Zenith", kind: "TRANSFER" });
    await expect(renamePaymentMethod(world.a.as.ADMIN, { methodId: world.b.transferMethodId, name: "Mine now" })).rejects.toBeInstanceOf(NotFoundError);

    const db = getDb();
    await expect(db.paymentMethod.delete({ where: { id: world.a.transferMethodId } })).rejects.toThrow();
    await expect(db.paymentMethod.update({ where: { id: world.a.transferMethodId }, data: { kind: "CASH" } })).rejects.toThrow();
    await expect(db.paymentMethod.update({ where: { id: world.a.cashMethodId }, data: { deactivatedAt: new Date() } })).rejects.toThrow();
  });
});

describe("paying", () => {
  beforeEach(async () => {
    await openA();
  });

  it("by transfer with a reference: no change, the reference is kept, and the receipt shows the method's name as it was", async () => {
    const result = await postSale(world.a.as.CASHIER, sale(3, [transfer("300.00", "GTB-99812")]));
    expect(result).toMatchObject({ total: "300.00", change: "0.00" });
    await renamePaymentMethod(world.a.as.ADMIN, { methodId: world.a.transferMethodId, name: "Transfer – Access" });

    expect((await getSale(world.a.as.CASHIER, { saleId: result.id })).payments).toEqual([
      { methodName: "Bank transfer", kind: "TRANSFER", amount: "300.00", tendered: null, change: null, reference: "GTB-99812" },
    ]);
  });

  it("split: part cash, part transfer — both are recorded, change comes only from the cash", async () => {
    const result = await postSale(world.a.as.CASHIER, sale(100, [cash("4000.00", "5000"), transfer("6000.00", "TRF-1")]));
    expect(result).toMatchObject({ total: "10000.00", change: "1000.00" });

    const detail = await getSale(world.a.as.CASHIER, { saleId: result.id });
    expect(detail.change).toBe("1000.00");
    expect(detail.payments).toEqual([
      { methodName: "Cash", kind: "CASH", amount: "4000.00", tendered: "5000.00", change: "1000.00", reference: null },
      { methodName: "Bank transfer", kind: "TRANSFER", amount: "6000.00", tendered: null, change: null, reference: "TRF-1" },
    ]);
    expect(await onShelf()).toBe("400.000");
  });

  it("refuses payments that do not add up exactly to the total, in either direction, and saves nothing", async () => {
    const attempt = async (payments: Part[]) => (await refusal(postSale(world.a.as.CASHIER, sale(100, payments)))).fieldErrors;
    expect((await attempt([cash("4000.00"), transfer("5999.99")])).payments).toBe("The payments add up to ₦9,999.99, but the total is ₦10,000.00. They must be exactly equal.");
    expect(await attempt([cash("4000.00"), transfer("6000.01")])).toHaveProperty("payments");
    expect(await attempt([transfer("10000.01")])).toHaveProperty("payments");
    expect((await attempt([])).payments).toBe("Say how the ₦10,000.00 is paid.");
    expect(await getDb().sale.count()).toBe(0);
    expect(await getDb().payment.count()).toBe(0);
    expect(await onShelf()).toBe("500.000");
  });

  it("refuses unknown, switched-off, repeated or foreign methods, bad amounts, and cash details on a non-cash payment", async () => {
    const pos = await createPaymentMethod(world.a.as.ADMIN, { name: "POS – Moniepoint", kind: "POS" });
    await setPaymentMethodActive(world.a.as.ADMIN, { methodId: pos.id, active: false });
    const attempt = async (payments: Part[]) => Object.keys((await refusal(postSale(world.a.as.CASHIER, sale(10, payments)))).fieldErrors);

    expect(await attempt([{ methodId: randomUUID(), amount: "1000.00" }])).toEqual(["payments.0.methodId"]);
    expect(await attempt([{ methodId: world.b.cashMethodId, amount: "1000.00" }])).toEqual(["payments.0.methodId"]);
    expect(await attempt([{ methodId: pos.id, amount: "1000.00" }])).toEqual(["payments.0.methodId"]);
    expect(await attempt([cash("500.00"), cash("500.00")])).toEqual(["payments.1.methodId"]);
    for (const amount of ["0", "-5", "lots", "1,000", ""]) {
      expect(await attempt([cash("1000.00"), transfer(amount)]), amount).toEqual(["payments.1.amount"]);
    }
    expect(await attempt([{ ...transfer("1000.00"), tendered: "2000" }])).toEqual(["payments.0.tendered"]);
    expect(await attempt([{ ...cash("1000.00"), reference: "X1" }])).toEqual(["payments.0.reference"]);
    expect(await attempt([cash("400.00", "300"), transfer("600.00")])).toEqual(["payments.0.tendered"]);
    expect(await getDb().sale.count()).toBe(0);
  });

  it("is refused by the database itself if a transfer carries change, or a payment's kind is rewritten", async () => {
    const { id } = await postSale(world.a.as.CASHIER, sale(1, [transfer("100.00")]));
    const payment = await getDb().payment.findFirstOrThrow({ where: { saleId: id } });
    await expect(getDb().payment.create({ data: { ...payment, id: randomUUID(), tendered: "200", changeGiven: "100" } })).rejects.toThrow();
    await expect(getDb().payment.update({ where: { id: payment.id }, data: { kind: "CASH" } })).rejects.toThrow();
  });
});

describe("the till", () => {
  it("must be open before anything is sold at a terminal", async () => {
    expect((await getCheckoutCatalogue(world.a.as.CASHIER)).terminals[0].tillOpen).toBe(false);
    const error = await refusal(postSale(world.a.as.CASHIER, sale(1, [cash("100.00")])));
    expect(error.message).toBe("Nothing was sold: the till of T1 is not open. Open the till, then complete the sale.");
    expect(await getDb().sale.count()).toBe(0);
    expect(await onShelf()).toBe("500.000");
    // The refusal used up no receipt number.
    await openA();
    expect((await postSale(world.a.as.CASHIER, sale(1, [cash("100.00")]))).receiptNumber).toBe("T1-000001");
    expect((await getCheckoutCatalogue(world.a.as.CASHIER)).terminals[0].tillOpen).toBe(true);
  });

  it("expected cash is the float plus cash sales, less change — transfers and POS do not count", async () => {
    const opened = await openA("5000");
    expect(opened.number).toBe(1);
    await postSale(world.a.as.CASHIER, sale(20, [cash("2000.00", "5000")])); // ₦3,000 change
    await postSale(world.a.as.CASHIER, sale(100, [cash("4000.00"), transfer("6000.00")]));
    await postSale(world.a.as.MANAGER, sale(7, [transfer("700.00", "TRF-2")]));

    // Blind for the person running the till; visible to those who review.
    const mine = await getTill(world.a.as.CASHIER, { terminalId: world.a.terminalId });
    expect(mine.open).toMatchObject({ number: 1, terminalCode: "T1", openingFloat: "5000.00", openedByName: "Test a.cashier", saleCount: 3, canClose: true, expectedCash: null });
    expect((await getTill(world.a.as.MANAGER, { terminalId: world.a.terminalId })).open).toMatchObject({ expectedCash: "11000.00", canClose: true });
    const open = await getTillSession(world.a.as.CASHIER, { sessionId: opened.id });
    expect(open).toMatchObject({ expectedCash: null, countedCash: null, canClose: true, saleCount: 3, salesTotal: "12700.00" });
    expect(open.byMethod).toEqual([{ methodName: "Bank transfer", kind: "TRANSFER", count: 2, amount: "6700.00" }]);

    // The cashier closes, and is told nothing about the result — then or later.
    const closed = await closeTill(world.a.as.CASHIER, { sessionId: opened.id, countedCash: "10900", note: "A ₦100 note is missing" });
    expect(closed).toEqual({ id: opened.id, number: 1, countedCash: "10900.00", expectedCash: null, difference: null, alreadyClosed: false });
    const cashiers = await getTillSession(world.a.as.CASHIER, { sessionId: opened.id });
    expect(cashiers).toMatchObject({ countedCash: "10900.00", expectedCash: null, difference: null, closingDifference: null, recounts: [], canRecount: false });
    expect(cashiers.byMethod.map((entry) => entry.kind)).toEqual(["TRANSFER"]);
    expect((await listTillSessions(world.a.as.CASHIER)).sessions[0]).toMatchObject({ number: 1, difference: null });
    expect(JSON.stringify(cashiers)).not.toContain("11000");

    // The manager sees all of it.
    const detail = await getTillSession(world.a.as.MANAGER, { sessionId: opened.id });
    expect(detail).toMatchObject({ openingFloat: "5000.00", expectedCash: "11000.00", countedCash: "10900.00", difference: "-100.00", closingDifference: "-100.00", closingNote: "A ₦100 note is missing", closedByName: "Test a.cashier", canClose: false, canRecount: true });
    expect(detail.byMethod).toEqual([
      { methodName: "Bank transfer", kind: "TRANSFER", count: 2, amount: "6700.00" },
      { methodName: "Cash", kind: "CASH", count: 2, amount: "6000.00" },
    ]);
    const log = await getDb().activityLog.findFirstOrThrow({ where: { action: "till.closed" } });
    expect(log.summary).toBe("Test a.cashier closed the till of T1 (TS-000001): counted ₦10,900.00, expected ₦11,000.00 — ₦100.00 SHORT. Note: A ₦100 note is missing");
  });

  it("once closed nothing more can be sold there until it is opened again, and each session counts only its own sales", async () => {
    const first = await openA("1000");
    await postSale(world.a.as.CASHIER, sale(5, [cash("500.00")]));
    expect(await closeTill(world.a.as.MANAGER, { sessionId: first.id, countedCash: "1500" })).toMatchObject({ difference: "0.00" });
    expect((await refusal(postSale(world.a.as.CASHIER, sale(1, [cash("100.00")])))).message).toMatch(/till of T1 is not open/);

    const second = await openA("200", world.a.as.MANAGER);
    expect(second.number).toBe(2);
    await postSale(world.a.as.MANAGER, sale(3, [cash("300.00")]));
    expect((await getTillSession(world.a.as.MANAGER, { sessionId: second.id })).expectedCash).toBe("500.00");
    expect((await getTillSession(world.a.as.MANAGER, { sessionId: first.id })).expectedCash).toBe("1500.00");
    const sales = await getDb().sale.findMany({ orderBy: { sequence: "asc" }, select: { tillSessionId: true } });
    expect(sales.map((row) => row.tillSessionId)).toEqual([first.id, second.id]);
  });

  it("a terminal has one open till at a time, also when two people open it at the same instant; each terminal has its own", async () => {
    const outcomes = await Promise.allSettled([openA("100"), openA("200", world.a.as.MANAGER), openA("300", world.a.as.ADMIN)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")!;
    expect(refused.reason).toBeInstanceOf(ValidationError);
    expect(refused.reason.message).toMatch(/The till of T1 is already open \(TS-000001, opened by /);
    expect(await getDb().tillSession.count({ where: { businessId: world.a.id } })).toBe(1);

    const t2 = await createTerminal(world.a.as.ADMIN, { code: "T2", name: "Second till", paperWidth: "MM80" });
    expect((await openTill(world.a.as.MANAGER, { terminalId: t2.id, openingFloat: "0" })).number).toBe(2);
    expect((await openTill(world.b.as.CASHIER, { terminalId: world.b.terminalId, openingFloat: "0" })).number).toBe(1);
  });

  it("is closed once, even when closed twice or by two people at the same instant", async () => {
    const opened = await openA("1000");
    await postSale(world.a.as.CASHIER, sale(5, [cash("500.00")]));
    const results = await Promise.all([
      closeTill(world.a.as.CASHIER, { sessionId: opened.id, countedCash: "1500" }),
      closeTill(world.a.as.MANAGER, { sessionId: opened.id, countedCash: "1400" }),
    ]);
    expect(results.filter((result) => !result.alreadyClosed)).toHaveLength(1);
    // Both are told about the one closing that was saved; only the manager is told its result.
    expect(results[0].countedCash).toBe(results[1].countedCash);
    expect(results[0].difference).toBeNull();
    expect(results[1].difference).toBe(results[1].countedCash === "1500.00" ? "0.00" : "-100.00");
    expect(await closeTill(world.a.as.ADMIN, { sessionId: opened.id, countedCash: "9" })).toMatchObject({ alreadyClosed: true });
    expect(await getDb().tillSessionClose.count()).toBe(1);
  });

  it("closing and selling at the same instant never lose a sale: every cash sale is either in the count or refused", async () => {
    const opened = await openA("0");
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 6 }, () => postSale(world.a.as.CASHIER, sale(1, [cash("100.00")]))),
      closeTill(world.a.as.CASHIER, { sessionId: opened.id, countedCash: "0" }),
    ]);
    const sold = outcomes.slice(0, 6).filter((outcome) => outcome.status === "fulfilled").length;
    const close = await getDb().tillSessionClose.findFirstOrThrow();
    expect(close.expectedCash.toFixed(2)).toBe(`${sold * 100}.00`);
    expect(await getDb().sale.count({ where: { tillSessionId: opened.id } })).toBe(sold);
    expect(await onShelf()).toBe(`${500 - sold}.000`);
  });

  it("can be recounted by a manager or admin the same day, each recount a record of its own; the closing count is never replaced", async () => {
    const opened = await openA("1000");
    await postSale(world.a.as.CASHIER, sale(5, [cash("500.00")]));
    // Still open: there is nothing to recount.
    expect((await refusal(recountTill(world.a.as.MANAGER, { sessionId: opened.id, countedCash: "1500", note: "Checking early" }))).message).toMatch(/still open/);
    await closeTill(world.a.as.CASHIER, { sessionId: opened.id, countedCash: "1400", note: "End of shift" });

    const first = await recountTill(world.a.as.MANAGER, { sessionId: opened.id, countedCash: "1450", note: "Found ₦50 under the tray" });
    expect(first).toMatchObject({ expectedCash: "1500.00", countedCash: "1450.00", difference: "-50.00" });
    await recountTill(world.a.as.ADMIN, { sessionId: opened.id, countedCash: "1500", note: "Counted together with the cashier" });

    const detail = await getTillSession(world.a.as.ACCOUNTANT, { sessionId: opened.id });
    // The closing count stands as it was; the session's result is that of the latest count.
    expect(detail).toMatchObject({ countedCash: "1400.00", closingDifference: "-100.00", difference: "0.00", closedByName: "Test a.cashier", canRecount: false });
    expect(detail.recounts.map((recount) => [recount.countedCash, recount.difference, recount.recountedByName, recount.note])).toEqual([
      ["1450.00", "-50.00", "Test a.manager", "Found ₦50 under the tray"],
      ["1500.00", "0.00", "Test a.admin", "Counted together with the cashier"],
    ]);
    expect((await listTillSessions(world.a.as.MANAGER)).sessions[0].difference).toBe("0.00");
    // The cashier still sees none of it.
    expect(await getTillSession(world.a.as.CASHIER, { sessionId: opened.id })).toMatchObject({ recounts: [], difference: null, expectedCash: null });

    const close = await getDb().tillSessionClose.findFirstOrThrow();
    expect([close.countedCash.toFixed(2), close.difference.toFixed(2)]).toEqual(["1400.00", "-100.00"]);
    const log = await getDb().activityLog.findMany({ where: { action: "till.recounted" }, orderBy: { createdAt: "asc" } });
    expect(log).toHaveLength(2);
    expect(log[0].summary).toBe(
      "Test a.manager recounted the till of T1 (TS-000001): counted ₦1,450.00, expected ₦1,500.00 — ₦50.00 SHORT. The closing count was ₦1,400.00. Note: Found ₦50 under the tray",
    );
  });

  it("a recount needs a note and a proper amount; the cashier and accountant cannot recount; nor can anyone on a later day", async () => {
    const opened = await openA("0");
    await closeTill(world.a.as.CASHIER, { sessionId: opened.id, countedCash: "0" });
    const good = { sessionId: opened.id, countedCash: "0", note: "Second look" };

    expect((await refusal(recountTill(world.a.as.MANAGER, { ...good, note: "" }))).fieldErrors).toHaveProperty("note");
    expect((await refusal(recountTill(world.a.as.MANAGER, { ...good, countedCash: "none" }))).fieldErrors).toHaveProperty("countedCash");
    for (const role of ["CASHIER", "ACCOUNTANT", "STOREKEEPER"] as const) {
      await expect(recountTill(world.a.as[role], good)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(recountTill(world.b.as.ADMIN, good)).rejects.toBeInstanceOf(NotFoundError);
    expect(await getDb().tillSessionRecount.count()).toBe(0);

    // Two days on, the till can no longer be recounted.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 24 * 60 * 60 * 1000 });
    try {
      expect((await refusal(recountTill(world.a.as.MANAGER, good))).message).toBe("A till can only be recounted on the day it was closed.");
      expect((await getTillSession(world.a.as.MANAGER, { sessionId: opened.id })).canRecount).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    await recountTill(world.ownerInA, good);

    const db = getDb();
    const recount = await db.tillSessionRecount.findFirstOrThrow();
    await expect(db.tillSessionRecount.update({ where: { id: recount.id }, data: { note: "changed" } })).rejects.toThrow();
    await expect(db.tillSessionRecount.delete({ where: { id: recount.id } })).rejects.toThrow();
    await expect(db.tillSessionRecount.create({ data: { ...recount, id: randomUUID(), difference: "7" } })).rejects.toThrow();
    await expect(db.tillSessionRecount.create({ data: { ...recount, id: randomUUID(), note: " " } })).rejects.toThrow();
  });

  it("keeps the note-by-note count with the float, the closing and a recount — for those who review tills only", async () => {
    const opened = await openTill(world.a.as.CASHIER, {
      terminalId: world.a.terminalId,
      openingFloat: "5000",
      breakdown: { notes: { "1000": "4", "500": "2" }, other: "" },
    });
    await closeTill(world.a.as.CASHIER, {
      sessionId: opened.id,
      countedCash: "4970.00",
      breakdown: { notes: { "1000": "4", "500": "1", "200": "2", "20": "3" }, other: "10" },
    });
    await recountTill(world.a.as.MANAGER, {
      sessionId: opened.id,
      countedCash: "5000",
      breakdown: { notes: { "1000": "5" }, other: "" },
      note: "Counted again with the cashier",
    });

    const detail = await getTillSession(world.a.as.MANAGER, { sessionId: opened.id });
    expect(detail.floatBreakdown).toEqual(["4 × ₦1,000", "2 × ₦500"]);
    expect(detail.closingBreakdown).toEqual(["4 × ₦1,000", "1 × ₦500", "2 × ₦200", "3 × ₦20", "Coins / other ₦10.00"]);
    expect(detail.recounts[0].breakdown).toEqual(["5 × ₦1,000"]);
    // The cashier is shown none of it afterwards.
    expect(await getTillSession(world.a.as.CASHIER, { sessionId: opened.id })).toMatchObject({ floatBreakdown: [], closingBreakdown: [], recounts: [] });

    // Without "Count by notes" there is simply no breakdown.
    const plain = await openA("100", world.a.as.MANAGER);
    expect((await getTillSession(world.a.as.MANAGER, { sessionId: plain.id })).floatBreakdown).toEqual([]);
  });

  it("refuses a note count that does not add up to the amount, or is not made of whole numbers, and saves nothing", async () => {
    const open = (breakdown: unknown, openingFloat = "5000") => refusal(openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat, breakdown }));
    expect((await open({ notes: { "1000": "4" }, other: "" })).fieldErrors.breakdown).toBe(
      "The notes add up to ₦4,000.00, but the amount typed is ₦5,000.00. Count again, or correct the amount.",
    );
    expect((await open({ notes: { "1000": "4.5" }, other: "" })).fieldErrors).toHaveProperty("breakdown");
    expect((await open({ notes: { "1000": "5" }, other: "some" })).fieldErrors).toHaveProperty("breakdown");
    // There is no ₦2,000 note.
    expect(Object.keys((await open({ notes: { "2000": "1" }, other: "" })).fieldErrors)).toEqual(["breakdown.notes"]);
    expect(await getDb().tillSession.count()).toBe(0);

    const opened = await openA("0");
    const close = await refusal(closeTill(world.a.as.CASHIER, { sessionId: opened.id, countedCash: "100", breakdown: { notes: { "50": "1" }, other: "" } }));
    expect(close.fieldErrors).toHaveProperty("breakdown");
    expect(await getDb().tillSessionClose.count()).toBe(0);
    await closeTill(world.a.as.CASHIER, { sessionId: opened.id, countedCash: "0" });
    const recount = await refusal(
      recountTill(world.a.as.MANAGER, { sessionId: opened.id, countedCash: "0", note: "Second look", breakdown: { notes: { "5": "1" }, other: "" } }),
    );
    expect(recount.fieldErrors).toHaveProperty("breakdown");
    expect(await getDb().tillSessionRecount.count()).toBe(0);
  });

  it("refuses bad amounts, an unknown or foreign terminal, and a terminal out of use", async () => {
    const attempt = async (input: Record<string, unknown>) => Object.keys((await refusal(openTill(world.a.as.CASHIER, input))).fieldErrors);
    for (const openingFloat of ["", "-1", "a lot", "1,000", "10.005"]) {
      expect(await attempt({ terminalId: world.a.terminalId, openingFloat }), openingFloat).toEqual(["openingFloat"]);
    }
    expect(await attempt({ terminalId: randomUUID(), openingFloat: "0" })).toEqual(["terminalId"]);
    expect(await attempt({ terminalId: world.b.terminalId, openingFloat: "0" })).toEqual(["terminalId"]);
    expect(await getDb().tillSession.count()).toBe(0);

    const opened = await openA();
    for (const countedCash of ["", "-1", "about 5000"]) {
      expect(Object.keys((await refusal(closeTill(world.a.as.CASHIER, { sessionId: opened.id, countedCash }))).fieldErrors), countedCash).toEqual(["countedCash"]);
    }
    expect(await getDb().tillSessionClose.count()).toBe(0);
  });

  it("can be run by cashier, manager and admin; reviewed by admin, manager and accountant; a cashier sees and closes only their own", async () => {
    for (const role of ["ACCOUNTANT", "STOREKEEPER"] as const) {
      await expect(openTill(world.a.as[role], { terminalId: world.a.terminalId, openingFloat: "0" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getTill(world.a.as[role], { terminalId: world.a.terminalId })).rejects.toBeInstanceOf(ForbiddenError);
    }
    const managers = await openA("0", world.a.as.MANAGER);
    // Not the cashier's session: to the cashier it does not exist.
    await expect(closeTill(world.a.as.CASHIER, { sessionId: managers.id, countedCash: "0" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getTillSession(world.a.as.CASHIER, { sessionId: managers.id })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listTillSessions(world.a.as.CASHIER)).sessions).toEqual([]);
    expect((await getTill(world.a.as.CASHIER, { terminalId: world.a.terminalId })).open).toMatchObject({ canClose: false, expectedCash: null });
    // But the cashier can sell at it.
    await postSale(world.a.as.CASHIER, sale(1, [cash("100.00")]));

    // The accountant reviews but cannot close; the storekeeper sees nothing.
    expect(await getTillSession(world.a.as.ACCOUNTANT, { sessionId: managers.id })).toMatchObject({ expectedCash: "100.00", canClose: false });
    expect(await listTillSessions(world.a.as.ACCOUNTANT)).toMatchObject({ ownOnly: false, canOperate: false });
    await expect(closeTill(world.a.as.ACCOUNTANT, { sessionId: managers.id, countedCash: "100" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listTillSessions(world.a.as.STOREKEEPER)).rejects.toBeInstanceOf(ForbiddenError);

    await closeTill(world.a.as.ADMIN, { sessionId: managers.id, countedCash: "100" });
    const mine = await openA("0", world.a.as.CASHIER);
    const list = await listTillSessions(world.a.as.CASHIER);
    expect(list).toMatchObject({ ownOnly: true, canOperate: true });
    expect(list.sessions.map((session) => session.id)).toEqual([mine.id]);
    expect((await listTillSessions(world.a.as.MANAGER, { status: "open" })).sessions.map((session) => session.number)).toEqual([2]);
    expect((await listTillSessions(world.a.as.MANAGER, { status: "closed" })).sessions.map((session) => [session.number, session.difference, session.closedByName])).toEqual([[1, "0.00", "Test a.admin"]]);
  });

  it("keeps businesses apart, and its records cannot be altered in the database", async () => {
    const inA = await openA("1000");
    const inB = await openTill(world.b.as.CASHIER, { terminalId: world.b.terminalId, openingFloat: "0" });
    await expect(getTillSession(world.b.as.ADMIN, { sessionId: inA.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(closeTill(world.b.as.ADMIN, { sessionId: inA.id, countedCash: "0" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listTillSessions(world.b.as.ADMIN)).sessions.map((session) => session.id)).toEqual([inB.id]);
    expect((await getTill(world.b.as.CASHIER, { terminalId: world.a.terminalId })).open).toBeNull();

    await closeTill(world.a.as.CASHIER, { sessionId: inA.id, countedCash: "1000" });
    const db = getDb();
    const close = await db.tillSessionClose.findFirstOrThrow();
    await expect(db.tillSession.update({ where: { id: inA.id }, data: { openingFloat: "1" } })).rejects.toThrow();
    await expect(db.tillSession.delete({ where: { id: inB.id } })).rejects.toThrow();
    await expect(db.tillSessionClose.update({ where: { id: close.id }, data: { countedCash: "1", difference: "-999" } })).rejects.toThrow();
    await expect(db.tillSessionClose.delete({ where: { id: close.id } })).rejects.toThrow();
    // A second closing, and a difference that is not "counted minus expected", cannot exist.
    await expect(db.tillSessionClose.create({ data: { ...close, id: randomUUID() } })).rejects.toThrow();
    await expect(db.tillSessionClose.create({ data: { ...close, id: randomUUID(), sessionId: inB.id, difference: "5" } })).rejects.toThrow();
  });
});
