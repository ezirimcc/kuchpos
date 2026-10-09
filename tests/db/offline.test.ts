import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueOfflinePass, offlineUntil, readOfflinePass } from "@/server/auth/offline-pass";
import type { AppContext } from "@/server/auth/context";
import { setUnitPrice } from "@/server/business/catalog";
import { createCustomer, listCustomers } from "@/server/business/customers";
import { getOfflineKit, listOfflineExceptions, reviewOfflineException } from "@/server/business/offline";
import { cancelSale, getSale, listSales, postOfflineSale, postSale } from "@/server/business/sales";
import { setStaffDisabled } from "@/server/business/staff";
import { receiveGoods } from "@/server/business/stock";
import { closeTill, getTillSession, openTill, openTillOffline } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, type World } from "../support/world";

/** Sales made on the checkout computer during an internet outage, sent when it returns (M12, C60, C61). */

let world: World;
/** The pass the cashier of business A was given while online. */
let pass = "";

beforeEach(async () => {
  await getDb().$executeRawUnsafe("DROP TRIGGER IF EXISTS `payment_test_failure`");
  world = await createWorld();
  for (const business of [world.a, world.b]) {
    await receiveGoods(business.as.ADMIN, {
      requestId: randomUUID(),
      supplierId: business.supplierId,
      locationId: business.shelfId,
      lines: [{ productId: business.product.id, unitId: business.product.baseUnitId, quantity: "100", unitCost: "50" }],
    });
  }
  await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "1000" });
  pass = (await getOfflineKit(world.a.as.CASHIER)).pass;
});

afterEach(async () => {
  vi.useRealTimers();
  await getDb().$executeRawUnsafe("DROP TRIGGER IF EXISTS `payment_test_failure`");
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

/** A sale of singles made offline at checkout T1 and paid in cash, as the checkout computer queues it. */
function made(number: number, singles: number, extra: Record<string, unknown> = {}, price = "100.00") {
  const total = `${(singles * Number.parseInt(price, 10)).toFixed(2)}`;
  return {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    pass,
    receiptNumber: `T1-F${String(number).padStart(6, "0")}`,
    deviceTime: new Date(Date.now() - 60_000).toISOString(),
    expectedTotal: total,
    payments: [{ methodId: world.a.cashMethodId, amount: total }],
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: String(singles), unitPrice: price }],
    ...extra,
  };
}
const send = (sale: ReturnType<typeof made>, as: AppContext = world.a.as.CASHIER) => postOfflineSale(as, sale);

const onShelf = async () =>
  (await getDb().stockBalance.findFirstOrThrow({ where: { productId: world.a.product.id, locationId: world.a.shelfId } })).quantity.toFixed(3);
const exceptions = async () => (await listOfflineExceptions(world.a.as.MANAGER)).rows.map((row) => [row.kind, row.summary]);
const counts = async () => ({ sales: await getDb().sale.count(), payments: await getDb().payment.count(), movements: await getDb().stockMovement.count({ where: { type: "SALE" } }) });

describe("the queue of sales made offline", () => {
  it("is saved once each with the receipt numbers that were printed, however often and however it is sent", async () => {
    const queue = [made(1, 2), made(2, 5), made(3, 1)];
    const first = [];
    for (const sale of queue) first.push(await send(sale));
    expect(first.map((saved) => [saved.receiptNumber, saved.total, saved.alreadySaved])).toEqual([
      ["T1-F000001", "200.00", false],
      ["T1-F000002", "500.00", false],
      ["T1-F000003", "100.00", false],
    ]);
    // The whole queue again, and again all at once: nothing new.
    for (const sale of queue) expect(await send(sale)).toMatchObject({ alreadySaved: true });
    const together = await Promise.all([...queue, ...queue].map((sale) => send(sale)));
    expect(together.every((saved) => saved.alreadySaved)).toBe(true);
    expect(together.map((saved) => saved.id).slice(0, 3)).toEqual(first.map((saved) => saved.id));

    expect(await counts()).toEqual({ sales: 3, payments: 3, movements: 3 });
    expect(await onShelf()).toBe("92.000");
    expect(await exceptions()).toEqual([]);

    const detail = await getDb().sale.findFirstOrThrow({ where: { receiptNumber: "T1-F000002" } });
    expect(detail).toMatchObject({ offline: true, cashierName: "Test a.cashier", sentByName: "Test a.cashier", terminalCode: "T1" });
    expect(detail.deviceTime).toBeInstanceOf(Date);
    // Online numbers carry on untouched, and the next offline number is known to the server.
    const online = await postSale(world.a.as.CASHIER, {
      requestId: randomUUID(),
      terminalId: world.a.terminalId,
      expectedTotal: "100.00",
      payments: [{ methodId: world.a.cashMethodId, amount: "100.00" }],
      lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "1", unitPrice: "100.00" }],
    });
    expect(online.receiptNumber).toBe("T1-000001");
    expect((await getOfflineKit(world.a.as.CASHIER)).terminals).toEqual([{ id: world.a.terminalId, code: "T1", paperWidth: "MM80", nextOfflineNumber: 4 }]);
  });

  it("the same sale sent twice at the same instant is saved once", async () => {
    const sale = made(1, 3);
    const both = await Promise.all([send(sale), send(sale), send(sale)]);
    expect(new Set(both.map((saved) => saved.id)).size).toBe(1);
    expect(both.filter((saved) => !saved.alreadySaved)).toHaveLength(1);
    expect(await counts()).toEqual({ sales: 1, payments: 1, movements: 1 });
    expect(await onShelf()).toBe("97.000");
  });

  it("losing the connection halfway through leaves nothing half-saved; sending again completes it", async () => {
    const queue = [made(1, 2), made(2, 4)];
    await send(queue[0]);
    await getDb().$executeRawUnsafe(
      "CREATE TRIGGER `payment_test_failure` BEFORE INSERT ON `payment` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Simulated failure while saving'",
    );
    await expect(send(queue[1])).rejects.toThrow();
    expect(await counts()).toEqual({ sales: 1, payments: 1, movements: 1 });
    expect(await onShelf()).toBe("98.000");
    await getDb().$executeRawUnsafe("DROP TRIGGER `payment_test_failure`");

    for (const sale of queue) await send(sale);
    expect(await counts()).toEqual({ sales: 2, payments: 2, movements: 2 });
    expect(await onShelf()).toBe("94.000");
    expect((await getDb().terminal.findUniqueOrThrow({ where: { id: world.a.terminalId } })).nextOfflineNumber).toBe(3);
  });

  it("goes into the till: the cash is expected at closing", async () => {
    await send(made(1, 5));
    const till = await getDb().tillSession.findFirstOrThrow({ where: { businessId: world.a.id } });
    const closed = await closeTill(world.a.as.MANAGER, { sessionId: till.id, countedCash: "1500" });
    expect(closed).toMatchObject({ expectedCash: "1500.00", difference: "0.00" });
    expect((await getTillSession(world.a.as.MANAGER, { sessionId: till.id })).saleCount).toBe(1);
  });
});

describe("what an offline sale is allowed that an online one is not", () => {
  it("more than the system holds is accepted: what is there is taken, the rest is noted, nothing goes below zero", async () => {
    const saved = await send(made(1, 130));
    expect(saved.total).toBe("13000.00");
    expect(await onShelf()).toBe("0.000");
    const line = await getDb().saleLine.findFirstOrThrow({ where: { saleId: saved.id } });
    expect([line.baseQuantity.toFixed(3), line.stockShort.toFixed(3), line.lineCost.toFixed(2)]).toEqual(["130.000", "30.000", "6500.00"]);
    const movement = await getDb().stockMovement.findFirstOrThrow({ where: { documentId: saved.id } });
    expect(movement.quantityDelta.toFixed(3)).toBe("-100.000");
    expect(await exceptions()).toEqual([
      ["STOCK_SHORT", '130 single of "A Seed Sachet" was sold, but the system held only 100 in Shelf. Count that product and adjust the stock.'],
    ]);

    // With nothing left at all, the next one is accepted too and moves no stock.
    const next = await send(made(2, 4));
    expect(await getDb().stockMovement.count({ where: { documentId: next.id } })).toBe(0);
    expect((await getDb().saleLine.findFirstOrThrow({ where: { saleId: next.id } })).stockShort.toFixed(3)).toBe("4.000");
    expect(await exceptions()).toHaveLength(2);

    // Online, the same is still refused.
    await expect(
      postSale(world.a.as.CASHIER, {
        requestId: randomUUID(),
        terminalId: world.a.terminalId,
        expectedTotal: "100.00",
        payments: [{ methodId: world.a.cashMethodId, amount: "100.00" }],
        lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "1", unitPrice: "100.00" }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Cancelling it the same day brings back everything the customer returns.
    await cancelSale(world.a.as.MANAGER, { saleId: saved.id, note: "Customer brought it all back" });
    expect(await onShelf()).toBe("130.000");
  });

  it("keeps the price the customer was charged when the price was changed during the outage, and says so", async () => {
    await setUnitPrice(world.a.as.ADMIN, { unitId: world.a.product.baseUnitId, price: "120" });
    const saved = await send(made(1, 2));
    expect(saved.total).toBe("200.00");
    const line = await getDb().saleLine.findFirstOrThrow({ where: { saleId: saved.id } });
    expect([line.unitPrice.toFixed(2), line.lineTotal.toFixed(2)]).toEqual(["100.00", "200.00"]);
    expect(await exceptions()).toEqual([
      ["PRICE_DIFFERENT", "A Seed Sachet (single) was sold at ₦100.00; the price set when the sale arrived was ₦120.00."],
    ]);
    // A sale made after the checkout got the new price is nothing special.
    await send(made(2, 1, {}, "120.00"));
    expect(await exceptions()).toHaveLength(1);
  });

  it("is recorded under the cashier who made it even when a manager sends it, and even if that cashier has since been disabled", async () => {
    await setStaffDisabled(world.a.as.ADMIN, { userId: world.a.staff.CASHIER.id, disabled: true });
    const saved = await send(made(1, 2), world.a.as.MANAGER);
    const row = await getDb().sale.findUniqueOrThrow({ where: { id: saved.id } });
    expect(row).toMatchObject({ cashierUserId: world.a.staff.CASHIER.id, cashierName: "Test a.cashier", sentByUserId: world.a.staff.MANAGER.id, sentByName: "Test a.manager" });
    expect(await exceptions()).toEqual([["ACCOUNT", "Test a.cashier's account had been disabled when this sale arrived."]]);
    const payment = await getDb().payment.findFirstOrThrow({ where: { saleId: saved.id } });
    expect(payment.receivedByName).toBe("Test a.cashier");
  });

  it("made after the cashier's time without internet ran out, or with an impossible clock, is accepted and noted", async () => {
    const late = new Date(offlineUntil().getTime() + 60 * 60_000);
    vi.useFakeTimers({ toFake: ["Date"], now: late.getTime() + 60_000 });
    await send(made(1, 1, { deviceTime: late.toISOString() }));
    vi.useRealTimers();
    await send(made(2, 1, { deviceTime: new Date(Date.now() + 3 * 60 * 60_000).toISOString() }));
    const found = await exceptions();
    expect(found.map((entry) => entry[0])).toEqual(["TIME", "TIME"]);
    const said = found.map((entry) => entry[1]).join(" | ");
    expect(said).toMatch(/after Test a.cashier's time for selling without internet ran out/);
    expect(said).toMatch(/which cannot be right/);
  });

  it("may be put under an existing customer's name, with no credit", async () => {
    const ada = (await createCustomer(world.a.as.CASHIER, { name: "Ada Okafor", phone: "08031234567" })).id;
    const saved = await send(made(1, 3, { customerId: ada }));
    expect((await getSale(world.a.as.MANAGER, { saleId: saved.id })).customer).toMatchObject({ name: "Ada Okafor" });
    expect((await listCustomers(world.a.as.MANAGER)).customers[0]).toMatchObject({ purchases: "300.00", visits: 1, balance: "0.00" });
  });

  it("two computers printing the same offline number: the second keeps its sale and is given the next number, which is noted", async () => {
    await send(made(7, 1));
    const second = await send(made(7, 2));
    expect(second.receiptNumber).toBe("T1-F000008");
    expect(await exceptions()).toEqual([
      ["RECEIPT_NUMBER", "The receipt was printed as T1-F000007, a number already used by another sale. This sale was saved as T1-F000008."],
    ]);
    expect((await getOfflineKit(world.a.as.CASHIER)).terminals[0].nextOfflineNumber).toBe(9);
  });
});

describe("what is still refused, and stays waiting on the computer", () => {
  it("a made-up, altered or foreign pass", async () => {
    const before = await counts();
    const [payload, signature] = pass.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), u: world.a.staff.MANAGER.id })).toString("base64url");
    const passOfB = (await getOfflineKit(world.b.as.CASHIER)).pass;
    for (const bad of ["nonsense", `${payload}.AAAA`, `${forged}.${signature}`, `${payload}`, passOfB]) {
      expect((await refusal(send(made(1, 1, { pass: bad })))).fieldErrors, bad.slice(0, 12)).toHaveProperty("pass");
    }
    expect(readOfflinePass(pass)).toMatchObject({ userId: world.a.staff.CASHIER.id, businessId: world.a.id, role: "CASHIER" });
    expect(readOfflinePass(issueOfflinePass(world.ownerInA).token)).toMatchObject({ role: "OWNER", businessId: world.a.id });
    expect(await counts()).toEqual(before);
    // An owner's pass works in the business it was signed for.
    await postOfflineSale(world.ownerInA, made(1, 1, { pass: issueOfflinePass(world.ownerInA).token }));
  });

  it("a discount, credit, a receipt number of the wrong kind, payments that do not add up", async () => {
    const ada = (await createCustomer(world.a.as.CASHIER, { name: "Ada Okafor", phone: "08031234567" })).id;
    expect((await refusal(send(made(1, 2, { discount: { amount: "50", reason: "Friend" }, expectedTotal: "150.00" })))).fieldErrors).toHaveProperty("discount.amount");
    expect((await refusal(send(made(1, 2, { customerId: ada, creditAmount: "200.00", payments: [] })))).fieldErrors).toHaveProperty("creditAmount");
    for (const receiptNumber of ["T1-000001", "T2-F000001", "T1-F1", "T1-F000000", ""]) {
      expect((await refusal(send(made(1, 1, { receiptNumber })))).fieldErrors, receiptNumber).toHaveProperty("receiptNumber");
    }
    expect((await refusal(send(made(1, 2, { payments: [{ methodId: world.a.cashMethodId, amount: "150.00" }] })))).fieldErrors).toHaveProperty("payments");
    expect((await refusal(send(made(1, 2, { expectedTotal: "150.00" })))).fieldErrors).toHaveProperty("expectedTotal");
    expect(await counts()).toEqual({ sales: 0, payments: 0, movements: 0 });
  });

  it("anyone who may not sell cannot send; business B cannot send A's sales", async () => {
    for (const role of ["ACCOUNTANT", "STOREKEEPER"] as const) {
      await expect(send(made(1, 1), world.a.as[role])).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await refusal(send(made(1, 1), world.b.as.CASHIER))).fieldErrors).toHaveProperty("pass");
    await expect(getOfflineKit(world.a.as.STOREKEEPER)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("a till opened without internet", () => {
  it("is opened when the internet returns, once, under the person who opened it; the waiting sales then go in", async () => {
    // Business B's till is closed, and its internet was down this morning.
    const kit = await getOfflineKit(world.b.as.CASHIER);
    const sale = { ...made(1, 2), terminalId: world.b.terminalId, pass: kit.pass, payments: [{ methodId: world.b.cashMethodId, amount: "200.00" }], lines: [{ productId: world.b.product.id, unitId: world.b.product.baseUnitId, quantity: "2", unitPrice: "100.00" }] };
    // Without its till the sale waits: nothing is saved.
    expect((await refusal(postOfflineSale(world.b.as.CASHIER, sale))).fieldErrors).toHaveProperty("till");
    expect(await getDb().sale.count()).toBe(0);

    const opening = { terminalId: world.b.terminalId, openingFloat: "2000", pass: kit.pass, deviceTime: new Date().toISOString() };
    const opened = await openTillOffline(world.b.as.MANAGER, opening);
    expect(opened).toMatchObject({ number: 1, alreadyOpen: false });
    expect(await openTillOffline(world.b.as.CASHIER, opening)).toEqual({ id: opened.id, number: 1, alreadyOpen: true });
    const session = await getDb().tillSession.findUniqueOrThrow({ where: { id: opened.id } });
    expect(session).toMatchObject({ openedByName: "Test b.cashier" });
    expect(session.openingFloat.toFixed(2)).toBe("2000.00");
    expect(await getDb().tillSession.count({ where: { businessId: world.b.id } })).toBe(1);
    expect((await getDb().activityLog.findFirstOrThrow({ where: { action: "till.opened_offline" } })).summary).toMatch(
      /^TS-000001 was opened by Test b.cashier without internet, at .* and sent to the server by Test b.manager now\.$/,
    );

    expect((await postOfflineSale(world.b.as.CASHIER, sale)).receiptNumber).toBe("T1-F000001");
    // A till already open before the outage is simply used.
    expect(await openTillOffline(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "5", pass, deviceTime: new Date().toISOString() })).toMatchObject({ alreadyOpen: true });
    await expect(openTillOffline(world.a.as.STOREKEEPER, { ...opening, terminalId: world.a.terminalId, pass })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("the offline exceptions report", () => {
  it("lists what was found, is marked as looked at by a manager or admin, and is kept apart per business", async () => {
    const saved = await send(made(1, 130));
    await setUnitPrice(world.a.as.ADMIN, { unitId: world.a.product.baseUnitId, price: "120" });
    await send(made(2, 1));

    const report = await listOfflineExceptions(world.a.as.ACCOUNTANT);
    expect(report).toMatchObject({ total: 3, waiting: 3, canReview: false });
    expect(report.rows.map((row) => row.kind).sort()).toEqual(["PRICE_DIFFERENT", "STOCK_SHORT", "STOCK_SHORT"]);
    const short = report.rows.find((row) => row.sale.id === saved.id)!;
    expect(short).toMatchObject({ review: null, sale: { receiptNumber: "T1-F000001", cashierName: "Test a.cashier", cancelled: false } });
    expect((await listOfflineExceptions(world.a.as.MANAGER, { kind: "PRICE_DIFFERENT" })).rows).toHaveLength(1);

    await expect(reviewOfflineException(world.a.as.ACCOUNTANT, { exceptionId: short.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reviewOfflineException(world.b.as.MANAGER, { exceptionId: short.id })).rejects.toBeInstanceOf(NotFoundError);
    await reviewOfflineException(world.a.as.MANAGER, { exceptionId: short.id, note: "Counted the shelf and adjusted" });
    await reviewOfflineException(world.a.as.ADMIN, { exceptionId: short.id, note: "Second look" });
    const after = await listOfflineExceptions(world.a.as.MANAGER, { status: "done" });
    expect(after).toMatchObject({ total: 1, waiting: 2, canReview: true });
    expect(after.rows[0].review).toMatchObject({ reviewedByName: "Test a.manager", note: "Counted the shelf and adjusted" });
    expect((await listOfflineExceptions(world.a.as.MANAGER, { status: "open" })).total).toBe(2);

    expect((await listOfflineExceptions(world.b.as.ADMIN)).rows).toEqual([]);
    for (const role of ["CASHIER", "STOREKEEPER"] as const) {
      await expect(listOfflineExceptions(world.a.as[role])).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Offline sales are in the sales list like any other.
    expect((await listSales(world.a.as.MANAGER)).sales.map((sale) => sale.receiptNumber).sort()).toEqual(["T1-F000001", "T1-F000002"]);

    const db = getDb();
    await expect(db.offlineException.updateMany({ data: { summary: "x" } })).rejects.toThrow();
    await expect(db.offlineException.deleteMany({})).rejects.toThrow();
    await expect(db.offlineExceptionReview.updateMany({ data: { note: "x" } })).rejects.toThrow();
    await expect(db.offlineExceptionReview.deleteMany({})).rejects.toThrow();
  });
});
