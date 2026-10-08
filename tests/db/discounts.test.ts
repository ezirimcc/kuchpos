import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveAtScreen,
  decideApprovalRequest,
  getApprovalRequest,
  listApprovals,
  listWaitingApprovals,
  requestApproval,
  withdrawApprovalRequest,
} from "@/server/business/approvals";
import { createCustomer, getCustomer, setCreditLimit } from "@/server/business/customers";
import { getCheckoutCatalogue, getSale, postSale } from "@/server/business/sales";
import { setTaxRate } from "@/server/business/settings";
import { receiveGoods } from "@/server/business/stock";
import { openTill } from "@/server/business/till";
import type { AppContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { getAuth } from "@/server/auth/auth";
import { resolveContext } from "@/server/auth/context";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, TEST_PASSWORD, type World } from "../support/world";

/** Extra discounts, and approval by a manager at the cashier's screen (also for credit over the limit). */

let world: World;

beforeEach(async () => {
  world = await createWorld();
  for (const business of [world.a, world.b]) {
    await receiveGoods(business.as.ADMIN, {
      requestId: randomUUID(),
      supplierId: business.supplierId,
      locationId: business.shelfId,
      lines: [{ productId: business.product.id, unitId: business.product.baseUnitId, quantity: "1000", unitCost: "50" }],
    });
    await openTill(business.as.CASHIER, { terminalId: business.terminalId, openingFloat: "1000" });
  }
});

afterEach(async () => {
  vi.useRealTimers();
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

type Line = { productId: string; unitId: string; quantity: string; unitPrice: string };
type Discount = { amount: string; percent?: string; reason: string };
type Cart = { requestId: string; lines: Line[]; discount?: Discount };

/** 1 pack (₦900) and 3 singles (₦300): ₦1,200 before any discount. */
function cart(discount?: Discount): Cart {
  return {
    requestId: randomUUID(),
    lines: [
      { productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: "1", unitPrice: "900.00" },
      { productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "3", unitPrice: "100.00" },
    ],
    discount,
  };
}

const TEN_PERCENT: Discount = { amount: "120.00", percent: "10", reason: "Loyal customer" };

/** The manager (or whoever is named) types their username and password at the cashier's screen. */
function approve(sale: Cart, by = "a.manager", options: { as?: AppContext; password?: string } = {}) {
  return approveAtScreen(options.as ?? world.a.as.CASHIER, {
    kind: "DISCOUNT",
    saleRequestId: sale.requestId,
    lines: sale.lines,
    discount: sale.discount,
    username: by,
    password: options.password ?? TEST_PASSWORD,
  });
}

/** Saves the sale, all paid in cash. */
function complete(sale: Cart, total: string, approvalId?: string, as: AppContext = world.a.as.CASHIER) {
  return postSale(as, {
    requestId: sale.requestId,
    terminalId: world.a.terminalId,
    expectedTotal: total,
    payments: [{ methodId: world.a.cashMethodId, amount: total }],
    lines: sale.lines,
    ...(sale.discount ? { discount: { ...sale.discount, approvalId: approvalId ?? "" } } : {}),
  });
}

const counts = async () => ({ sales: await getDb().sale.count(), uses: await getDb().approvalUse.count(), payments: await getDb().payment.count() });

describe("a discount on a sale", () => {
  it("cannot be completed by a cashier without a manager's approval, even when sent straight to the server", async () => {
    const sale = cart(TEN_PERCENT);
    expect((await refusal(complete(sale, "1080.00"))).fieldErrors["discount.approvalId"]).toBe(
      "A manager or admin must approve this discount before the sale can be completed.",
    );
    expect((await refusal(complete(sale, "1080.00", randomUUID()))).fieldErrors["discount.approvalId"]).toMatch(/could not be found/);
    expect((await refusal(complete(sale, "1080.00", "anything"))).fieldErrors).toHaveProperty("discount.approvalId");
    // Leaving the discount out but paying the lower amount is simply the wrong total.
    expect((await refusal(complete({ ...sale, discount: undefined }, "1080.00"))).fieldErrors).toHaveProperty("expectedTotal");
    expect(await counts()).toEqual({ sales: 0, uses: 0, payments: 0 });
  });

  it("once approved is saved: the amount, the percentage, the reason, each line's share, tax on what was charged", async () => {
    await setTaxRate(world.a.as.ADMIN, { ratePercent: "7.5" });
    const sale = cart(TEN_PERCENT);
    const given = await approve(sale);
    expect(given.approvedByName).toBe("Test a.manager");
    const saved = await complete(sale, "1080.00", given.approvalId);
    expect(saved.total).toBe("1080.00");

    const detail = await getSale(world.a.as.CASHIER, { saleId: saved.id });
    expect(detail).toMatchObject({
      subtotal: "1200.00",
      discountAmount: "120.00",
      discountPercent: "10.00",
      discountReason: "Loyal customer",
      discountApprovedBy: "Test a.manager",
      total: "1080.00",
    });
    const rows = await getDb().saleLine.findMany({ where: { saleId: saved.id }, orderBy: { lineNumber: "asc" } });
    expect(rows.map((row) => [row.lineTotal.toFixed(2), row.discountAmount.toFixed(2), row.taxAmount.toFixed(2)])).toEqual([
      // 810.00 and 270.00 were really charged; 7.5% inside them is 56.51 and 18.84.
      ["900.00", "90.00", "56.51"],
      ["300.00", "30.00", "18.84"],
    ]);
    const stored = await getDb().sale.findUniqueOrThrow({ where: { id: saved.id } });
    expect(stored.taxTotal.toFixed(2)).toBe("75.35");
    const payment = await getDb().payment.findFirstOrThrow({ where: { saleId: saved.id } });
    expect(payment.amount.toFixed(2)).toBe("1080.00");

    // Sending the same sale again changes nothing and gives the same sale back.
    const again = await complete(sale, "1080.00", given.approvalId);
    expect(again).toMatchObject({ id: saved.id, alreadySaved: true });
    expect(await counts()).toEqual({ sales: 1, uses: 1, payments: 1 });
  });

  it("typed as a Naira amount needs no percentage; a percentage that does not give the amount is refused", async () => {
    const sale = cart({ amount: "200", reason: "Damaged pack" });
    const saved = await complete(sale, "1000.00", (await approve(sale)).approvalId);
    expect(await getSale(world.a.as.ADMIN, { saleId: saved.id })).toMatchObject({ discountAmount: "200.00", discountPercent: null, total: "1000.00" });

    for (const discount of [
      { amount: "100.00", percent: "10", reason: "Does not match" },
      { amount: "120.00", percent: "ten", reason: "Not a number" },
      { amount: "0", reason: "Nothing" },
      { amount: "-5", reason: "Negative" },
      { amount: "1200.01", reason: "More than the sale" },
      { amount: "1,000", reason: "Comma" },
    ]) {
      const error = await refusal(approve(cart(discount)));
      expect(Object.keys(error.fieldErrors).join(), discount.reason).toMatch(/^discount\.(amount|percent)$/);
      const direct = await refusal(complete(cart(discount), "1000.00", undefined, world.a.as.MANAGER));
      expect(Object.keys(direct.fieldErrors).join(), discount.reason).toMatch(/discount\.(amount|percent)/);
    }
    expect((await refusal(approve(cart({ amount: "50", reason: " " })))).fieldErrors).toHaveProperty("discount.reason");
    // The whole sale may be given away, with approval: nothing is then paid.
    const free = cart({ amount: "1200", percent: "100", reason: "Replacement for spoiled goods" });
    const gift = await postSale(world.a.as.CASHIER, {
      requestId: free.requestId,
      terminalId: world.a.terminalId,
      expectedTotal: "0.00",
      payments: [],
      lines: free.lines,
      discount: { ...free.discount!, approvalId: (await approve(free)).approvalId },
    });
    expect(gift.total).toBe("0.00");
  });

  it("approved for one sale does not fit another, a changed cart or a changed discount", async () => {
    const sale = cart(TEN_PERCENT);
    const { approvalId } = await approve(sale);

    // One more single in the cart.
    const bigger = { ...sale, lines: [sale.lines[0], { ...sale.lines[1], quantity: "4" }], discount: { ...TEN_PERCENT, amount: "130.00" } };
    expect((await refusal(complete(bigger, "1170.00", approvalId))).fieldErrors["discount.approvalId"]).toMatch(/changed after it was approved/);
    // A bigger discount on the same cart.
    const greedier = { ...sale, discount: { amount: "600.00", percent: "50", reason: "Loyal customer" } };
    expect((await refusal(complete(greedier, "600.00", approvalId))).fieldErrors["discount.approvalId"]).toMatch(/changed after it was approved/);
    // The same cart and discount, but a different sale.
    const another = { ...sale, requestId: randomUUID() };
    expect((await refusal(complete(another, "1080.00", approvalId))).fieldErrors["discount.approvalId"]).toMatch(/changed after it was approved/);
    expect(await counts()).toEqual({ sales: 0, uses: 0, payments: 0 });

    // Used as it was approved, it works — once.
    await complete(sale, "1080.00", approvalId);
    expect((await refusal(complete(another, "1080.00", approvalId))).fieldErrors).toHaveProperty("discount.approvalId");
    expect(await counts()).toEqual({ sales: 1, uses: 1, payments: 1 });
  });

  it("an approval for credit cannot be used for a discount", async () => {
    const ada = (await createCustomer(world.a.as.CASHIER, { name: "Ada Okafor", phone: "08031234567" })).id;
    await setCreditLimit(world.a.as.MANAGER, { customerId: ada, creditLimit: "100" });
    const sale = cart(TEN_PERCENT);
    const credit = await approveAtScreen(world.a.as.CASHIER, {
      kind: "CREDIT_OVER_LIMIT",
      saleRequestId: sale.requestId,
      lines: sale.lines,
      customerId: ada,
      creditAmount: "1080.00",
      username: "a.manager",
      password: TEST_PASSWORD,
    });
    expect((await refusal(complete(sale, "1080.00", credit.approvalId))).fieldErrors["discount.approvalId"]).toMatch(/could not be found/);
  });

  it("runs out after ten minutes if it is not used", async () => {
    const sale = cart(TEN_PERCENT);
    const { approvalId, expiresAt } = await approve(sale);
    expect(Math.round((expiresAt.getTime() - Date.now()) / 60_000)).toBe(10);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 + 1000 });
    expect((await refusal(complete(sale, "1080.00", approvalId))).fieldErrors["discount.approvalId"]).toMatch(/has run out: it lasts 10 minutes/);
    expect((await listApprovals(world.a.as.MANAGER)).rows[0]).toMatchObject({ sale: null, expired: true });
    vi.useRealTimers();
    expect(await counts()).toEqual({ sales: 0, uses: 0, payments: 0 });
  });

  it("can be approved only by an active manager, admin or owner of that business, with the right password", async () => {
    const sale = cart(TEN_PERCENT);
    const message = "That username and password were not accepted, or that person is not allowed to approve this.";
    // A cashier's own account, another cashier-level account, and people from another business.
    for (const username of ["a.cashier", "a.accountant", "b.manager", "b.admin", "nobody.here"]) {
      expect((await refusal(approve(sale, username))).fieldErrors.password, username).toBe(message);
    }
    expect(await getDb().approval.count()).toBe(0);
    expect(await getDb().activityLog.count({ where: { action: "approval.refused" } })).toBe(5);
  });

  it("is given by the admin and by an owner too; a disabled manager and a wrong password are refused", async () => {
    const sale = cart(TEN_PERCENT);
    expect((await refusal(approve(sale, "a.manager", { password: "not-the-password" }))).fieldErrors).toHaveProperty("password");
    await getDb().user.update({ where: { id: world.a.staff.MANAGER.id }, data: { disabledAt: new Date() } });
    expect((await refusal(approve(sale))).fieldErrors).toHaveProperty("password");

    expect((await approve(sale, "A.Admin")).approvedByName).toBe("Test a.admin");
    const other = cart(TEN_PERCENT);
    const byOwner = await approve(other, "owner");
    await complete(other, "1080.00", byOwner.approvalId);
    const log = await getDb().activityLog.findMany({ where: { action: "approval.given" }, orderBy: { createdAt: "asc" } });
    expect(log.map((entry) => [entry.actorName, entry.businessId])).toEqual([
      ["Test a.admin", world.a.id],
      ["Test owner", world.a.id],
    ]);
    expect(log[0].summary).toBe(
      "Test a.admin (Admin) approved a discount of ₦120.00 on a sale of ₦1,200.00, asked for by Test a.cashier. Reason: Loyal customer.",
    );
  });

  it("after five wrong tries no more are taken for ten minutes, even with the right password", async () => {
    const sale = cart(TEN_PERCENT);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await refusal(approve(sale, "a.manager", { password: `guess-${attempt}` }));
    }
    expect((await refusal(approve(sale))).fieldErrors.password).toMatch(/Too many wrong tries/);
    // Another cashier-level person cannot carry on guessing against the same manager either.
    expect((await refusal(approve(sale, "a.manager", { as: world.a.as.ADMIN }))).fieldErrors.password).toMatch(/Too many wrong tries/);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 + 1000 });
    expect((await approve(sale)).approvedByName).toBe("Test a.manager");
  });

  it("a manager or admin who is selling approves their own, and it is recorded all the same", async () => {
    const sale = cart(TEN_PERCENT);
    const saved = await complete(sale, "1080.00", undefined, world.a.as.MANAGER);
    expect(await getSale(world.a.as.MANAGER, { saleId: saved.id })).toMatchObject({ discountAmount: "120.00", discountApprovedBy: "Test a.manager" });
    const report = await listApprovals(world.a.as.MANAGER);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ ownSale: true, requestedByName: "Test a.manager", approvedByName: "Test a.manager", amount: "120.00" });
  });

  it("is not for those who may not sell or may not ask for one", async () => {
    const sale = cart(TEN_PERCENT);
    for (const role of ["ACCOUNTANT", "STOREKEEPER"] as const) {
      await expect(approve(sale, "a.manager", { as: world.a.as[role] })).rejects.toBeInstanceOf(ForbiddenError);
    }
    const catalogue = await getCheckoutCatalogue(world.a.as.CASHIER);
    expect(catalogue).toMatchObject({ canDiscount: true, canApproveDiscount: false });
    expect(await getCheckoutCatalogue(world.a.as.MANAGER)).toMatchObject({ canDiscount: true, canApproveDiscount: true });
  });

  it("approvals cannot be changed or removed in the database", async () => {
    const sale = cart(TEN_PERCENT);
    const { approvalId } = await approve(sale);
    await complete(sale, "1080.00", approvalId);
    const db = getDb();
    await expect(db.approval.update({ where: { id: approvalId }, data: { amount: "1.00" } })).rejects.toThrow();
    await expect(db.approval.delete({ where: { id: approvalId } })).rejects.toThrow();
    await expect(db.approvalUse.deleteMany({})).rejects.toThrow();
    await expect(db.approvalUse.updateMany({ data: { saleId: randomUUID() } })).rejects.toThrow();
  });
});

describe("the discounts and approvals report", () => {
  it("shows who asked, who approved, why, how much, when and on which sale; business B sees none of it", async () => {
    const used = cart(TEN_PERCENT);
    const saved = await complete(used, "1080.00", (await approve(used)).approvalId);
    const unused = cart({ amount: "50", reason: "Changed their mind" });
    await approve(unused, "a.admin");

    const report = await listApprovals(world.a.as.ACCOUNTANT);
    expect(report).toMatchObject({ total: 2, discountTotal: "120.00", discountCount: 1 });
    expect(report.rows.map((row) => [row.requestedByName, row.approvedByName, row.reason, row.amount, row.basis, row.sale?.receiptNumber ?? null, row.expired])).toEqual([
      ["Test a.cashier", "Test a.admin", "Changed their mind", "50.00", "1200.00", null, false],
      ["Test a.cashier", "Test a.manager", "Loyal customer", "120.00", "1200.00", saved.receiptNumber, false],
    ]);
    expect(report.rows[1].approvedAt).toBeInstanceOf(Date);
    expect((await listApprovals(world.a.as.ADMIN, { search: "loyal" })).rows).toHaveLength(1);
    expect((await listApprovals(world.a.as.ADMIN, { search: saved.receiptNumber })).rows).toHaveLength(1);
    expect((await listApprovals(world.a.as.ADMIN, { kind: "CREDIT_OVER_LIMIT" })).rows).toHaveLength(0);

    expect((await listApprovals(world.b.as.ADMIN)).rows).toEqual([]);
    for (const role of ["CASHIER", "STOREKEEPER"] as const) {
      await expect(listApprovals(world.a.as[role])).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe("credit over a customer's limit", () => {
  it("can be approved at the cashier's screen by a manager, for that customer, that amount and that sale only", async () => {
    const ada = (await createCustomer(world.a.as.CASHIER, { name: "Ada Okafor", phone: "08031234567" })).id;
    const bola = (await createCustomer(world.a.as.CASHIER, { name: "Bola Ade", phone: "08055550000" })).id;
    for (const customerId of [ada, bola]) await setCreditLimit(world.a.as.MANAGER, { customerId, creditLimit: "500" });

    const sale = cart();
    const onCredit = (customerId: string, creditAmount: string, creditApprovalId = "", requestId = sale.requestId) =>
      postSale(world.a.as.CASHIER, {
        requestId,
        terminalId: world.a.terminalId,
        expectedTotal: "1200.00",
        payments: creditAmount === "1200.00" ? [] : [{ methodId: world.a.cashMethodId, amount: "200.00" }],
        customerId,
        creditAmount,
        lines: sale.lines,
        ...(creditApprovalId ? { creditApprovalId } : {}),
      });
    const ask = (customerId: string, creditAmount: string, username = "a.manager") =>
      approveAtScreen(world.a.as.CASHIER, {
        kind: "CREDIT_OVER_LIMIT",
        saleRequestId: sale.requestId,
        lines: sale.lines,
        customerId,
        creditAmount,
        username,
        password: TEST_PASSWORD,
      });

    expect((await refusal(onCredit(ada, "1200.00"))).fieldErrors.creditAmount).toMatch(/only ₦500.00 more can go on credit/);
    expect((await refusal(ask(ada, "1200.00", "a.cashier"))).fieldErrors).toHaveProperty("password");
    expect((await refusal(ask(ada, "1200.00", "b.manager"))).fieldErrors).toHaveProperty("password");
    // The accountant may not set credit limits, so may not allow this either.
    expect((await refusal(ask(ada, "1200.00", "a.accountant"))).fieldErrors).toHaveProperty("password");

    const { approvalId } = await ask(ada, "1200.00");
    // Not for another customer, another amount, or another sale.
    expect((await refusal(onCredit(bola, "1200.00", approvalId))).fieldErrors.creditAmount).toMatch(/changed after it was approved/);
    expect((await refusal(onCredit(ada, "1000.00", approvalId))).fieldErrors.creditAmount).toMatch(/changed after it was approved/);
    expect((await refusal(onCredit(ada, "1200.00", approvalId, randomUUID()))).fieldErrors.creditAmount).toMatch(/changed after it was approved/);
    expect((await getCustomer(world.a.as.ADMIN, { customerId: ada })).balance).toBe("0.00");

    const saved = await onCredit(ada, "1200.00", approvalId);
    expect((await getCustomer(world.a.as.ADMIN, { customerId: ada })).balance).toBe("1200.00");
    const log = await getDb().activityLog.findFirstOrThrow({ where: { action: "sale.credit_over_limit" } });
    expect(log.summary).toBe(
      `Test a.manager let Ada Okafor go over their credit limit on sale ${saved.receiptNumber} (sold by Test a.cashier): ₦1,200.00 on credit, now owing ₦1,200.00.`,
    );
    const report = await listApprovals(world.a.as.ADMIN, { kind: "CREDIT_OVER_LIMIT" });
    expect(report.rows[0]).toMatchObject({ kind: "CREDIT_OVER_LIMIT", amount: "1200.00", basis: "1200.00", approvedByName: "Test a.manager", sale: { receiptNumber: saved.receiptNumber } });
    // It is not counted as a discount.
    expect(report).toMatchObject({ discountTotal: "0.00", discountCount: 0 });
  });
});

describe("approval from the manager's own computer", () => {
  /** The cashier sends the cart's discount to be approved. */
  const send = (sale: Cart, as: AppContext = world.a.as.CASHIER) =>
    requestApproval(as, { kind: "DISCOUNT", saleRequestId: sale.requestId, lines: sale.lines, discount: sale.discount });

  it("a cashier sends a discount; the manager sees the items and approves; the cashier's sale then goes through, once", async () => {
    const sale = cart(TEN_PERCENT);
    const { requestId } = await send(sale);
    expect(await getApprovalRequest(world.a.as.CASHIER, { requestId })).toMatchObject({ status: "WAITING" });
    // Sending the very same thing again does not make a second request.
    expect((await send(sale)).requestId).toBe(requestId);

    const { requests } = await listWaitingApprovals(world.a.as.MANAGER);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      id: requestId,
      kind: "DISCOUNT",
      amount: "120.00",
      basis: "1200.00",
      reason: "Loyal customer",
      requestedByName: "Test a.cashier",
      details: {
        subtotal: "1200.00",
        discountPercent: "10.00",
        customer: null,
        lines: [
          { productName: "A Seed Sachet", quantity: "1.000", unitName: "pack", unitPrice: "900.00", lineTotal: "900.00" },
          { productName: "A Seed Sachet", quantity: "3.000", unitName: "single", unitPrice: "100.00", lineTotal: "300.00" },
        ],
      },
    });
    // Until it is answered, the sale cannot be completed.
    expect((await refusal(complete(sale, "1080.00"))).fieldErrors).toHaveProperty("discount.approvalId");

    await decideApprovalRequest(world.a.as.MANAGER, { requestId, approve: true, note: "Fine for this customer" });
    const answer = await getApprovalRequest(world.a.as.CASHIER, { requestId });
    expect(answer).toMatchObject({ status: "APPROVED", approvedByName: "Test a.manager" });
    expect((await listWaitingApprovals(world.a.as.MANAGER)).requests).toEqual([]);

    const approvalId = (answer as { approvalId: string }).approvalId;
    const saved = await complete(sale, "1080.00", approvalId);
    expect(await getSale(world.a.as.ADMIN, { saleId: saved.id })).toMatchObject({ discountAmount: "120.00", discountApprovedBy: "Test a.manager" });
    // The approval that came from it obeys the same rules: one sale, once.
    expect((await refusal(complete({ ...sale, requestId: randomUUID() }, "1080.00", approvalId))).fieldErrors).toHaveProperty("discount.approvalId");

    const report = await listApprovals(world.a.as.ACCOUNTANT);
    expect(report.rows[0]).toMatchObject({ remote: true, ownSale: false, requestedByName: "Test a.cashier", approvedByName: "Test a.manager", sale: { receiptNumber: saved.receiptNumber } });
    const log = await getDb().activityLog.findFirstOrThrow({ where: { action: "approval.given" } });
    expect(log.summary).toBe(
      "Test a.manager (Manager) approved a discount of ₦120.00 on a sale of ₦1,200.00, asked for by Test a.cashier. Reason: Loyal customer. Note: Fine for this customer.",
    );
  });

  it("a refusal reaches the cashier with the note, and gives no approval; a request is answered only once", async () => {
    const sale = cart(TEN_PERCENT);
    const { requestId } = await send(sale);
    await decideApprovalRequest(world.a.as.ADMIN, { requestId, approve: false, note: "Too much" });
    expect(await getApprovalRequest(world.a.as.CASHIER, { requestId })).toEqual({ status: "REFUSED", refusedByName: "Test a.admin", note: "Too much" });
    expect(await getDb().approval.count()).toBe(0);
    expect((await refusal(decideApprovalRequest(world.a.as.MANAGER, { requestId, approve: true }))).message).toMatch(/already been answered/);
    expect(await getDb().approval.count()).toBe(0);
    // The cashier may ask again: that is a new request.
    expect((await send(sale)).requestId).not.toBe(requestId);
  });

  it("two managers answering at the same instant give exactly one answer", async () => {
    const { requestId } = await send(cart(TEN_PERCENT));
    const answers = await Promise.allSettled([
      decideApprovalRequest(world.a.as.MANAGER, { requestId, approve: true }),
      decideApprovalRequest(world.a.as.ADMIN, { requestId, approve: true }),
      decideApprovalRequest(world.ownerInA, { requestId, approve: false }),
    ]);
    expect(answers.filter((answer) => answer.status === "fulfilled")).toHaveLength(1);
    expect(await getDb().approvalRequestDecision.count()).toBe(1);
    expect(await getDb().approval.count()).toBeLessThanOrEqual(1);
  });

  it("a request waits ten minutes, can be taken back, and after either cannot be approved", async () => {
    const first = await send(cart(TEN_PERCENT));
    await withdrawApprovalRequest(world.a.as.CASHIER, { requestId: first.requestId });
    expect(await getApprovalRequest(world.a.as.CASHIER, { requestId: first.requestId })).toEqual({ status: "WITHDRAWN" });
    expect((await refusal(decideApprovalRequest(world.a.as.MANAGER, { requestId: first.requestId, approve: true }))).message).toMatch(/already been answered/);
    // Taking it back twice is harmless.
    await withdrawApprovalRequest(world.a.as.CASHIER, { requestId: first.requestId });

    const second = await send(cart(TEN_PERCENT));
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 + 1000 });
    expect(await getApprovalRequest(world.a.as.CASHIER, { requestId: second.requestId })).toEqual({ status: "EXPIRED" });
    expect((await listWaitingApprovals(world.a.as.MANAGER)).requests).toEqual([]);
    expect((await refusal(decideApprovalRequest(world.a.as.MANAGER, { requestId: second.requestId, approve: true }))).message).toMatch(/has run out/);
    vi.useRealTimers();
    expect(await getDb().approval.count()).toBe(0);
  });

  it("only those who may approve see or answer requests, and only their own business's; only the sender may ask after or take back a request", async () => {
    const { requestId } = await send(cart(TEN_PERCENT));
    for (const role of ["CASHIER", "ACCOUNTANT", "STOREKEEPER"] as const) {
      await expect(listWaitingApprovals(world.a.as[role]), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(decideApprovalRequest(world.a.as[role], { requestId, approve: true }), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await listWaitingApprovals(world.b.as.MANAGER)).requests).toEqual([]);
    await expect(decideApprovalRequest(world.b.as.MANAGER, { requestId, approve: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getApprovalRequest(world.b.as.CASHIER, { requestId })).rejects.toBeInstanceOf(NotFoundError);
    // Another person of the same business who sells cannot read or take back someone else's request.
    await expect(getApprovalRequest(world.a.as.MANAGER, { requestId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(withdrawApprovalRequest(world.a.as.ADMIN, { requestId })).rejects.toBeInstanceOf(NotFoundError);
    // Those who may not sell cannot send one.
    await expect(send(cart(TEN_PERCENT), world.a.as.STOREKEEPER)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listWaitingApprovals(world.ownerInA)).requests).toHaveLength(1);
  });

  it("works for credit over a customer's limit too, showing the manager what the customer owes", async () => {
    const ada = (await createCustomer(world.a.as.CASHIER, { name: "Ada Okafor", phone: "08031234567" })).id;
    await setCreditLimit(world.a.as.MANAGER, { customerId: ada, creditLimit: "500" });
    const sale = cart();
    const { requestId } = await requestApproval(world.a.as.CASHIER, {
      kind: "CREDIT_OVER_LIMIT",
      saleRequestId: sale.requestId,
      lines: sale.lines,
      customerId: ada,
      creditAmount: "1200.00",
    });
    const [waiting] = (await listWaitingApprovals(world.a.as.MANAGER)).requests;
    expect(waiting).toMatchObject({ kind: "CREDIT_OVER_LIMIT", amount: "1200.00", basis: "1200.00", details: { customer: { name: "Ada Okafor", owes: "0.00", creditLimit: "500.00" } } });
    await decideApprovalRequest(world.a.as.MANAGER, { requestId, approve: true });
    const answer = (await getApprovalRequest(world.a.as.CASHIER, { requestId })) as { approvalId: string };
    await postSale(world.a.as.CASHIER, {
      requestId: sale.requestId,
      terminalId: world.a.terminalId,
      expectedTotal: "1200.00",
      payments: [],
      customerId: ada,
      creditAmount: "1200.00",
      lines: sale.lines,
      creditApprovalId: answer.approvalId,
    });
    expect((await getCustomer(world.a.as.ADMIN, { customerId: ada })).balance).toBe("1200.00");
  });

  it("requests and their answers cannot be changed or removed in the database", async () => {
    const { requestId } = await send(cart(TEN_PERCENT));
    await decideApprovalRequest(world.a.as.MANAGER, { requestId, approve: false });
    const db = getDb();
    await expect(db.approvalRequest.update({ where: { id: requestId }, data: { amount: "1.00" } })).rejects.toThrow();
    await expect(db.approvalRequest.deleteMany({})).rejects.toThrow();
    await expect(db.approvalRequestDecision.updateMany({ data: { outcome: "APPROVED" } })).rejects.toThrow();
    await expect(db.approvalRequestDecision.deleteMany({})).rejects.toThrow();
  });

  it("a screen checking for news by itself does not put off the automatic sign-out", async () => {
    const db = getDb();
    const signedIn = await getAuth().api.signInUsername({ body: { username: "a.manager", password: TEST_PASSWORD }, returnHeaders: true });
    const headers = new Headers({ cookie: signedIn.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") });
    const session = { id: (await resolveContext(headers)).actor.sessionId };
    const longAgo = new Date(Date.now() - 20 * 60_000);
    await db.session.update({ where: { id: session.id }, data: { lastActiveAt: longAgo } });
    await resolveContext(headers, { passive: true });
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).lastActiveAt.getTime()).toBe(longAgo.getTime());
    await resolveContext(headers);
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).lastActiveAt.getTime()).toBeGreaterThan(longAgo.getTime());
  });
});
