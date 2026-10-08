import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDashboard } from "@/server/business/dashboard";
import { cancelSale, getSale, listSales, postSale } from "@/server/business/sales";
import { receiveGoods } from "@/server/business/stock";
import { closeTill, getTillSession, openTill } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, type World } from "../support/world";

/** Cancelling a whole sale on the day it was made (SPEC C48). */

let world: World;
let tillId = "";

beforeEach(async () => {
  world = await createWorld();
  // 100 singles on the Shelf and 100 in the Storeroom of each business, bought at ₦50; sold at ₦100.
  for (const business of [world.a, world.b]) {
    for (const locationId of [business.shelfId, business.storeroomId]) {
      await receiveGoods(business.as.ADMIN, {
        requestId: randomUUID(),
        supplierId: business.supplierId,
        locationId,
        lines: [{ productId: business.product.id, unitId: business.product.baseUnitId, quantity: "100", unitCost: "50" }],
      });
    }
  }
  tillId = (await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "1000" })).id;
  await openTill(world.b.as.CASHIER, { terminalId: world.b.terminalId, openingFloat: "1000" });
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

/** A sale of singles at ₦100 each in business A: `shelf` from the Shelf and `storeroom` straight from the Storeroom. */
async function sell(shelf: number, payments: Part[], storeroom = 0, as = world.a.as.MANAGER) {
  const line = (quantity: number, fromStoreroom: boolean) => ({
    productId: world.a.product.id,
    unitId: world.a.product.baseUnitId,
    quantity: String(quantity),
    unitPrice: "100.00",
    fromStoreroom,
  });
  return postSale(as, {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    expectedTotal: `${(shelf + storeroom) * 100}.00`,
    payments,
    lines: [...(shelf > 0 ? [line(shelf, false)] : []), ...(storeroom > 0 ? [line(storeroom, true)] : [])],
  });
}
const cash = (amount: string, tendered?: string): Part => ({ methodId: world.a.cashMethodId, amount, ...(tendered ? { tendered } : {}) });
const transfer = (amount: string): Part => ({ methodId: world.a.transferMethodId, amount, reference: "TRF-1" });

async function held(locationId: string): Promise<string> {
  const balance = await getDb().stockBalance.findUniqueOrThrow({ where: { productId_locationId: { productId: world.a.product.id, locationId } } });
  return balance.quantity.toFixed(3);
}

const expectedCash = async (sessionId = tillId) => (await getTillSession(world.a.as.MANAGER, { sessionId })).expectedCash;

/** Everything a sale consists of, to prove a cancellation leaves it exactly as it was. */
async function theSaleItself(saleId: string) {
  const db = getDb();
  return JSON.stringify({
    sale: await db.sale.findUniqueOrThrow({ where: { id: saleId } }),
    lines: await db.saleLine.findMany({ where: { saleId }, orderBy: { lineNumber: "asc" } }),
    payments: await db.payment.findMany({ where: { saleId }, orderBy: { id: "asc" } }),
    movements: await db.stockMovement.findMany({ where: { documentId: saleId }, orderBy: { id: "asc" } }),
  });
}

async function everything() {
  const db = getDb();
  return JSON.stringify({
    cancellations: await db.saleCancellation.count(),
    refunds: await db.refund.count(),
    movements: await db.stockMovement.count(),
    balances: await db.stockBalance.findMany({ orderBy: { id: "asc" } }),
    averages: await db.product.findMany({ orderBy: { id: "asc" }, select: { averageCost: true } }),
    activity: await db.activityLog.count(),
  });
}

describe("cancelling a sale", () => {
  it("puts the goods back where they came from, refunds each payment by its own method, and lowers the till's expected cash", async () => {
    const sale = await sell(7, [cash("400.00", "500"), transfer("600.00")], 3);
    expect([await held(world.a.shelfId), await held(world.a.storeroomId)]).toEqual(["93.000", "97.000"]);
    expect(await expectedCash()).toBe("1400.00");
    const before = await theSaleItself(sale.id);

    const result = await cancelSale(world.a.as.MANAGER, { saleId: sale.id, note: "Customer changed his mind" });
    expect(result).toEqual({ id: sale.id, receiptNumber: "T1-000001", refunded: "1000.00", alreadyCancelled: false });

    // The sale, its lines, its payments and its own stock movements are untouched.
    expect(await theSaleItself(sale.id)).toBe(before);

    expect([await held(world.a.shelfId), await held(world.a.storeroomId)]).toEqual(["100.000", "100.000"]);
    const cancellation = await getDb().saleCancellation.findFirstOrThrow();
    const back = await getDb().stockMovement.findMany({ where: { documentId: cancellation.id }, orderBy: { quantityDelta: "asc" } });
    expect(back.map((movement) => [movement.type, movement.locationId, movement.quantityDelta.toFixed(3), movement.documentNumber, movement.userName])).toEqual([
      ["SALE_CANCELLATION", world.a.storeroomId, "3.000", "T1-000001", "Test a.manager"],
      ["SALE_CANCELLATION", world.a.shelfId, "7.000", "T1-000001", "Test a.manager"],
    ]);
    const refunds = await getDb().refund.findMany({ orderBy: { amount: "asc" } });
    expect(refunds.map((refund) => [refund.methodName, refund.kind, refund.amount.toFixed(2), refund.tillSessionId, refund.refundedByName])).toEqual([
      ["Cash", "CASH", "400.00", tillId, "Test a.manager"],
      ["Bank transfer", "TRANSFER", "600.00", tillId, "Test a.manager"],
    ]);
    // Float 1,000 + 400 cash in − 400 cash back.
    expect(await expectedCash()).toBe("1000.00");
    expect((await getDb().product.findUniqueOrThrow({ where: { id: world.a.product.id } })).averageCost.toFixed(4)).toBe("50.0000");

    const log = await getDb().activityLog.findFirstOrThrow({ where: { action: "sale.cancelled" } });
    expect(log.summary).toBe(
      "Test a.manager cancelled sale T1-000001 (₦1,000.00, sold by Test a.manager). Refunded: ₦400.00 Cash, ₦600.00 Bank transfer. Reason: Customer changed his mind",
    );
  });

  it("shows the sale as cancelled, with who, when and why, and leaves it out of the totals", async () => {
    const kept = await sell(2, [cash("200.00")], 0, world.a.as.CASHIER);
    const gone = await sell(5, [cash("500.00")], 0, world.a.as.CASHIER);
    expect(await getSale(world.a.as.CASHIER, { saleId: gone.id })).toMatchObject({ cancellation: null, canCancel: false });
    expect(await getSale(world.a.as.ADMIN, { saleId: gone.id })).toMatchObject({ cancellation: null, canCancel: true });

    await cancelSale(world.a.as.ADMIN, { saleId: gone.id, note: "Wrong customer" });

    const detail = await getSale(world.a.as.CASHIER, { saleId: gone.id });
    expect(detail).toMatchObject({ total: "500.00", canCancel: false, cancellation: { note: "Wrong customer", cancelledByName: "Test a.admin" } });
    expect((await getSale(world.a.as.ADMIN, { saleId: gone.id })).canCancel).toBe(false);

    const list = await listSales(world.a.as.CASHIER);
    expect(list.sales.map((row) => [row.receiptNumber, row.cancelled])).toEqual([
      ["T1-000002", true],
      ["T1-000001", false],
    ]);
    expect(list.sumOfTotals).toBe("200.00");
    const session = await getTillSession(world.a.as.MANAGER, { sessionId: tillId });
    expect(session).toMatchObject({ saleCount: 1, salesTotal: "200.00", cancelledCount: 1, cashRefunded: "500.00", expectedCash: "1200.00" });
    expect((await getTillSession(world.a.as.CASHIER, { sessionId: tillId })).cashRefunded).toBeNull();
    const dashboard = await getDashboard(world.a.as.ADMIN);
    expect(dashboard.salesToday).toMatchObject({ count: 1, total: "200.00" });
    expect(dashboard.collectedToday).toEqual({ total: "200.00", cash: "200.00" });
    expect(kept.receiptNumber).toBe("T1-000001");
  });

  it("happens once: a second attempt changes nothing, also when two people cancel at the same instant", async () => {
    const sale = await sell(4, [cash("400.00")]);
    const first = await cancelSale(world.a.as.MANAGER, { saleId: sale.id, note: "Customer changed his mind" });
    const again = await cancelSale(world.a.as.ADMIN, { saleId: sale.id, note: "Trying again" });
    expect([first.alreadyCancelled, again.alreadyCancelled]).toEqual([false, true]);
    expect(await held(world.a.shelfId)).toBe("100.000");

    const other = await sell(6, [cash("600.00")]);
    const results = await Promise.all([
      cancelSale(world.a.as.MANAGER, { saleId: other.id, note: "Customer changed his mind" }),
      cancelSale(world.a.as.ADMIN, { saleId: other.id, note: "Customer changed her mind" }),
      cancelSale(world.ownerInA, { saleId: other.id, note: "Customer changed their mind" }),
    ]);
    expect(results.filter((result) => !result.alreadyCancelled)).toHaveLength(1);
    expect(await held(world.a.shelfId)).toBe("100.000");
    expect(await getDb().saleCancellation.count()).toBe(2);
    expect(await getDb().refund.count()).toBe(2);
    expect(await expectedCash()).toBe("1000.00");
  });

  it("stays exact when a cancellation, sales and a delivery of the same product happen at the same instant", async () => {
    const sale = await sell(10, [cash("1000.00")]);
    const outcomes = await Promise.allSettled([
      cancelSale(world.a.as.MANAGER, { saleId: sale.id, note: "Customer changed his mind" }),
      sell(3, [cash("300.00")]),
      sell(4, [transfer("400.00")], 0, world.a.as.CASHIER),
      receiveGoods(world.a.as.ADMIN, {
        requestId: randomUUID(),
        supplierId: world.a.supplierId,
        locationId: world.a.shelfId,
        lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "20", unitCost: "50" }],
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => String((outcome as PromiseRejectedResult).reason))).toEqual([]);
    // 100 − 10 + 10 − 3 − 4 + 20
    expect(await held(world.a.shelfId)).toBe("113.000");
    expect(await expectedCash()).toBe("1300.00");
  });
});

describe("cancellations that are refused, with nothing changed", () => {
  it("needs a note", async () => {
    const sale = await sell(1, [cash("100.00")]);
    const before = await everything();
    for (const note of ["", "   ", "oops"]) {
      expect((await refusal(cancelSale(world.a.as.MANAGER, { saleId: sale.id, note }))).fieldErrors.note).toMatch(/Say why/);
    }
    expect(await everything()).toBe(before);
  });

  it("is not possible for a sale from an earlier day", async () => {
    const sale = await sell(1, [cash("100.00")]);
    const before = await everything();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 24 * 60 * 60 * 1000 });
    try {
      const error = await refusal(cancelSale(world.a.as.ADMIN, { saleId: sale.id, note: "Customer came back" }));
      expect(error.message).toMatch(/only be cancelled on the day it was made/);
      expect((await getSale(world.a.as.ADMIN, { saleId: sale.id })).canCancel).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(await everything()).toBe(before);
  });

  it("only an admin, manager or owner can cancel; another business's sale does not exist", async () => {
    const sale = await sell(1, [cash("100.00")], 0, world.a.as.CASHIER);
    const before = await everything();
    for (const role of ["CASHIER", "ACCOUNTANT", "STOREKEEPER"] as const) {
      await expect(cancelSale(world.a.as[role], { saleId: sale.id, note: "Let me undo this" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(cancelSale(world.b.as.ADMIN, { saleId: sale.id, note: "Not mine to cancel" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelSale(world.a.as.ADMIN, { saleId: randomUUID(), note: "No such sale" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await everything()).toBe(before);
    expect((await cancelSale(world.ownerInA, { saleId: sale.id, note: "Owner cancelling" })).alreadyCancelled).toBe(false);
  });

  it("a cash sale cannot be cancelled while the till is closed, or if the till does not hold the cash; a transfer sale can", async () => {
    const cashSale = await sell(5, [cash("500.00")]);
    const transferSale = await sell(2, [transfer("200.00")]);
    await closeTill(world.a.as.MANAGER, { sessionId: tillId, countedCash: "1500" });
    const before = await everything();

    expect((await refusal(cancelSale(world.a.as.MANAGER, { saleId: cashSale.id, note: "Customer changed his mind" }))).message).toMatch(
      /the till of T1 is not open, and the cash refund has to come out of it/,
    );
    expect(await everything()).toBe(before);

    // A transfer is given back outside the drawer, so the till does not matter.
    await cancelSale(world.a.as.MANAGER, { saleId: transferSale.id, note: "Paid twice by mistake" });
    expect((await getDb().refund.findFirstOrThrow()).tillSessionId).toBeNull();
    expect(await held(world.a.shelfId)).toBe("95.000");

    // Reopened with too little: the refund of ₦500 cannot come out of ₦200.
    const second = await openTill(world.a.as.MANAGER, { terminalId: world.a.terminalId, openingFloat: "200" });
    const short = await refusal(cancelSale(world.a.as.MANAGER, { saleId: cashSale.id, note: "Customer changed his mind" }));
    expect(short.message).toBe("Nothing was cancelled: ₦500.00 in cash has to be given back, but the till of T1 should only hold ₦200.00.");
    await sell(4, [cash("400.00")]);
    await cancelSale(world.a.as.MANAGER, { saleId: cashSale.id, note: "Customer changed his mind" });
    // The refund comes out of the till that is open now, not the closed one the sale was made in.
    expect(await expectedCash(second.id)).toBe("100.00");
    expect(await expectedCash(tillId)).toBe("1500.00");
  });
});

describe("the record of a cancellation", () => {
  it("cannot be changed or deleted, and the database itself allows one per sale and no cash refund without a till", async () => {
    const sale = await sell(1, [cash("100.00")]);
    const other = await sell(1, [cash("100.00")]);
    await cancelSale(world.a.as.MANAGER, { saleId: sale.id, note: "Customer changed his mind" });
    const db = getDb();
    const cancellation = await db.saleCancellation.findFirstOrThrow();
    const refund = await db.refund.findFirstOrThrow();
    const payment = await db.payment.findFirstOrThrow({ where: { saleId: other.id } });

    await expect(db.saleCancellation.update({ where: { id: cancellation.id }, data: { note: "changed" } })).rejects.toThrow();
    await expect(db.saleCancellation.delete({ where: { id: cancellation.id } })).rejects.toThrow();
    await expect(db.refund.update({ where: { id: refund.id }, data: { amount: "1" } })).rejects.toThrow();
    await expect(db.refund.delete({ where: { id: refund.id } })).rejects.toThrow();
    await expect(db.saleCancellation.create({ data: { ...cancellation, id: randomUUID() } })).rejects.toThrow();
    await expect(db.saleCancellation.create({ data: { ...cancellation, id: randomUUID(), saleId: other.id, note: " " } })).rejects.toThrow();
    await expect(db.refund.create({ data: { ...refund, id: randomUUID() } })).rejects.toThrow();
    await expect(db.refund.create({ data: { ...refund, id: randomUUID(), paymentId: payment.id, saleId: other.id, tillSessionId: null } })).rejects.toThrow();
  });
});
