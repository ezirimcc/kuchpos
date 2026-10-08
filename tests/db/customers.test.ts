import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCustomer,
  getCustomer,
  getCustomerStatement,
  getRepaymentOptions,
  listCustomers,
  recordRepayment,
  setCreditLimit,
  setCustomerActive,
  updateCustomer,
} from "@/server/business/customers";
import { getDashboard } from "@/server/business/dashboard";
import { cancelSale, getCheckoutCatalogue, getSale, listSales, postSale } from "@/server/business/sales";
import { receiveGoods } from "@/server/business/stock";
import { closeTill, getTillSession, openTill } from "@/server/business/till";
import type { AppContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { createWorld, expectBalancesMatchMovements, expectCustomerBalancesMatchEntries, type World } from "../support/world";

/** Customers, selling on credit, the account history, and repayments. */

let world: World;
let tillId = "";
/** A customer of business A with a ₦20,000 credit limit, and one with no credit. */
let ada = "";
let bola = "";

beforeEach(async () => {
  world = await createWorld();
  for (const business of [world.a, world.b]) {
    await receiveGoods(business.as.ADMIN, {
      requestId: randomUUID(),
      supplierId: business.supplierId,
      locationId: business.shelfId,
      lines: [{ productId: business.product.id, unitId: business.product.baseUnitId, quantity: "1000", unitCost: "50" }],
    });
  }
  tillId = (await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "1000" })).id;
  ada = (await createCustomer(world.a.as.CASHIER, { name: "Ada Okafor", phone: "0803 123 4567", address: "12 Market Road", city: "Aba", state: "Abia" })).id;
  bola = (await createCustomer(world.a.as.CASHIER, { name: "Bola Ade", phone: "08055550000" })).id;
  await setCreditLimit(world.a.as.MANAGER, { customerId: ada, creditLimit: "20000" });
});

// The golden rules, checked after every single test in this file.
afterEach(async () => {
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

type Options = { customerId?: string; credit?: string; cash?: string; transfer?: string; as?: AppContext };

/** A sale of singles at ₦100 each in business A. What is not on credit or by transfer is paid in cash. */
function sale(singles: number, options: Options = {}) {
  const payments = [
    ...(options.cash ? [{ methodId: world.a.cashMethodId, amount: options.cash }] : []),
    ...(options.transfer ? [{ methodId: world.a.transferMethodId, amount: options.transfer }] : []),
  ];
  return {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    expectedTotal: `${singles * 100}.00`,
    payments,
    customerId: options.customerId ?? "",
    creditAmount: options.credit ?? "",
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: String(singles), unitPrice: "100.00" }],
  };
}
const sell = (singles: number, options: Options = {}) => postSale(options.as ?? world.a.as.CASHIER, sale(singles, options));

function repay(customerId: string, amount: string, extra: Record<string, unknown> = {}) {
  return { requestId: randomUUID(), customerId, amount, methodId: world.a.transferMethodId, ...extra };
}
const repayCash = (customerId: string, amount: string, extra: Record<string, unknown> = {}) =>
  repay(customerId, amount, { methodId: world.a.cashMethodId, terminalId: world.a.terminalId, ...extra });

const owes = async (customerId: string) => (await getCustomer(world.a.as.ADMIN, { customerId })).balance;

async function everything() {
  const db = getDb();
  return JSON.stringify({
    customers: await db.customer.findMany({ orderBy: { id: "asc" }, select: { id: true, balance: true, creditLimit: true } }),
    entries: await db.customerAccountEntry.count(),
    repayments: await db.repayment.count(),
    allocations: await db.repaymentAllocation.count(),
    sales: await db.sale.count(),
    payments: await db.payment.count(),
    balances: await db.stockBalance.findMany({ orderBy: { id: "asc" } }),
  });
}

describe("customer records", () => {
  it("keeps name, phone, address, city and state; the phone is tidied and must be unique within the business", async () => {
    const detail = await getCustomer(world.a.as.CASHIER, { customerId: ada });
    expect(detail).toMatchObject({ name: "Ada Okafor", phone: "08031234567", address: "12 Market Road", city: "Aba", state: "Abia", balance: "0.00", creditLimit: "20000.00", availableCredit: "20000.00", active: true });
    expect(await getCustomer(world.a.as.CASHIER, { customerId: bola })).toMatchObject({ address: null, city: null, state: null, creditLimit: null, availableCredit: null });

    expect((await refusal(createCustomer(world.a.as.CASHIER, { name: "Another Ada", phone: "(0803) 123-4567" }))).fieldErrors.phone).toMatch(/already has that phone number/);
    expect((await refusal(updateCustomer(world.a.as.CASHIER, { customerId: bola, name: "Bola Ade", phone: "08031234567" }))).fieldErrors.phone).toMatch(/already has/);
    // The same phone number is fine in another business: nothing is shared.
    await createCustomer(world.b.as.CASHIER, { name: "Ada Okafor", phone: "08031234567" });

    for (const phone of ["", "12345", "phone", "0803-ABC-4567", "1234567890123456"]) {
      expect((await refusal(createCustomer(world.a.as.CASHIER, { name: "Chidi", phone }))).fieldErrors, phone).toHaveProperty("phone");
    }
    expect((await refusal(createCustomer(world.a.as.CASHIER, { name: " ", phone: "08090000000" }))).fieldErrors).toHaveProperty("name");
    await createCustomer(world.a.as.ACCOUNTANT, { name: "Chidi", phone: "+234 809 000 0000" });
    expect((await listCustomers(world.a.as.CASHIER, { search: "chi" })).customers.map((customer) => customer.phone)).toEqual(["+2348090000000"]);
  });

  it("can be edited and taken out of use, never deleted; the list is searched by name, phone or city", async () => {
    await updateCustomer(world.a.as.MANAGER, { customerId: bola, name: "Bola Adeyemi", phone: "08055550000", address: "", city: "Lagos", state: "Lagos" });
    const find = async (input: Record<string, string>) => (await listCustomers(world.a.as.CASHIER, input)).customers.map((customer) => customer.name);
    expect(await find({})).toEqual(["Ada Okafor", "Bola Adeyemi"]);
    expect(await find({ search: "adey" })).toEqual(["Bola Adeyemi"]);
    expect(await find({ search: "0803 123" })).toEqual(["Ada Okafor"]);
    expect(await find({ search: "lagos" })).toEqual(["Bola Adeyemi"]);
    expect(await find({ owing: "1" })).toEqual([]);

    await setCustomerActive(world.a.as.CASHIER, { customerId: bola, active: false });
    expect((await getCustomer(world.a.as.CASHIER, { customerId: bola })).active).toBe(false);
    expect((await getCheckoutCatalogue(world.a.as.CASHIER)).customers.map((customer) => customer.name)).toEqual(["Ada Okafor"]);
    expect((await refusal(sell(1, { customerId: bola, cash: "100.00" }))).fieldErrors).toHaveProperty("customerId");
    await expect(getDb().customer.delete({ where: { id: bola } })).rejects.toThrow();

    const actions = (await getDb().activityLog.findMany({ where: { action: { startsWith: "customer." } }, orderBy: { createdAt: "asc" } })).map((entry) => entry.action);
    expect(actions).toEqual(["customer.created", "customer.created", "customer.credit_limit_changed", "customer.updated", "customer.deactivated"]);
  });

  it("can be managed by admin, manager, accountant and cashier; a cashier sees the balance but not the statement; a storekeeper sees nothing", async () => {
    await sell(10, { customerId: ada, credit: "1000.00" });
    for (const role of ["ADMIN", "MANAGER", "ACCOUNTANT"] as const) {
      const detail = await getCustomer(world.a.as[role], { customerId: ada });
      expect(detail).toMatchObject({ balance: "1000.00", canSeeStatement: true, canManage: true, canRecordRepayment: true, canSetCreditLimit: role !== "ACCOUNTANT" });
      expect(detail.unpaidSales).toHaveLength(1);
      expect((await getCustomerStatement(world.a.as[role], { customerId: ada })).lines).toHaveLength(1);
    }
    const cashiers = await getCustomer(world.a.as.CASHIER, { customerId: ada });
    expect(cashiers).toMatchObject({ balance: "1000.00", canSeeStatement: false, canSetCreditLimit: false, unpaidSales: [], limitHistory: [] });
    await expect(getCustomerStatement(world.a.as.CASHIER, { customerId: ada })).rejects.toBeInstanceOf(ForbiddenError);
    for (const role of ["CASHIER", "ACCOUNTANT"] as const) {
      await expect(setCreditLimit(world.a.as[role], { customerId: ada, creditLimit: "999999" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(listCustomers(world.a.as.STOREKEEPER)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getCustomer(world.a.as.STOREKEEPER, { customerId: ada })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createCustomer(world.a.as.STOREKEEPER, { name: "X Y", phone: "08090000000" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordRepayment(world.a.as.STOREKEEPER, repay(ada, "100"))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("belong to one business: B cannot see, change, sell to or take repayments from A's customers", async () => {
    await sell(10, { customerId: ada, credit: "1000.00" });
    const before = await everything();
    const b = world.b.as.ADMIN;
    await expect(getCustomer(b, { customerId: ada })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getCustomerStatement(b, { customerId: ada })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateCustomer(b, { customerId: ada, name: "Mine now", phone: "08031234567" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setCustomerActive(b, { customerId: ada, active: false })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setCreditLimit(b, { customerId: ada, creditLimit: "1" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordRepayment(b, { requestId: randomUUID(), customerId: ada, amount: "100", methodId: world.b.transferMethodId })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listCustomers(b)).customers).toEqual([]);

    await openTill(world.b.as.CASHIER, { terminalId: world.b.terminalId, openingFloat: "0" });
    const inB = {
      requestId: randomUUID(),
      terminalId: world.b.terminalId,
      expectedTotal: "100.00",
      payments: [{ methodId: world.b.cashMethodId, amount: "100.00" }],
      customerId: ada,
      lines: [{ productId: world.b.product.id, unitId: world.b.product.baseUnitId, quantity: "1", unitPrice: "100.00" }],
    };
    expect((await refusal(postSale(world.b.as.CASHIER, inB))).fieldErrors).toHaveProperty("customerId");
    // A's repayment cannot use B's payment method either.
    expect((await refusal(recordRepayment(world.a.as.ADMIN, repay(ada, "100", { methodId: world.b.transferMethodId })))).fieldErrors).toHaveProperty("methodId");
    expect(await everything()).toBe(before);
  });
});

describe("the credit limit", () => {
  it("is set by an admin or manager, with a history; empty means no credit at all", async () => {
    await setCreditLimit(world.a.as.ADMIN, { customerId: ada, creditLimit: "35000.50" });
    await setCreditLimit(world.a.as.ADMIN, { customerId: ada, creditLimit: "35000.50" });
    await setCreditLimit(world.ownerInA, { customerId: ada, creditLimit: "" });
    const detail = await getCustomer(world.a.as.MANAGER, { customerId: ada });
    expect(detail).toMatchObject({ creditLimit: null, availableCredit: null });
    expect(detail.limitHistory.map((change) => [change.oldLimit, change.newLimit, change.changedByName])).toEqual([
      ["35000.50", null, "Test owner"],
      ["20000.00", "35000.50", "Test a.admin"],
      [null, "20000.00", "Test a.manager"],
    ]);
    for (const creditLimit of ["-1", "lots", "1,000", "10.005"]) {
      expect((await refusal(setCreditLimit(world.a.as.ADMIN, { customerId: ada, creditLimit }))).fieldErrors, creditLimit).toHaveProperty("creditLimit");
    }
    const change = await getDb().creditLimitChange.findFirstOrThrow();
    await expect(getDb().creditLimitChange.update({ where: { id: change.id }, data: { newLimit: "1" } })).rejects.toThrow();
    await expect(getDb().creditLimitChange.delete({ where: { id: change.id } })).rejects.toThrow();
  });
});

describe("selling on credit", () => {
  it("a sale of ₦10,000 with ₦4,000 cash and ₦6,000 credit raises the customer's balance by ₦6,000", async () => {
    const result = await sell(100, { customerId: ada, credit: "6000.00", cash: "4000.00" });
    expect(result).toMatchObject({ total: "10000.00", change: "0.00" });
    expect(await owes(ada)).toBe("6000.00");

    const detail = await getSale(world.a.as.CASHIER, { saleId: result.id });
    expect(detail).toMatchObject({ total: "10000.00", creditAmount: "6000.00", owedAfter: "6000.00", customer: { id: ada, name: "Ada Okafor", phone: "08031234567" } });
    expect(detail.payments.map((payment) => [payment.methodName, payment.amount])).toEqual([["Cash", "4000.00"]]);
    expect((await listSales(world.a.as.CASHIER)).sales[0]).toMatchObject({ customerName: "Ada Okafor", creditAmount: "6000.00" });
    expect((await listSales(world.a.as.CASHIER, { search: "okafor" })).sales).toHaveLength(1);

    const statement = await getCustomerStatement(world.a.as.ACCOUNTANT, { customerId: ada });
    expect(statement.lines.map((line) => [line.type, line.documentNumber, line.amount, line.balanceAfter, line.createdByName])).toEqual([
      ["CREDIT_SALE", "T1-000001", "6000.00", "6000.00", "Test a.cashier"],
    ]);
    // Only the cash is in the till, and only the cash was "collected".
    expect((await getTillSession(world.a.as.MANAGER, { sessionId: tillId })).expectedCash).toBe("5000.00");
    const dashboard = await getDashboard(world.a.as.ADMIN);
    expect(dashboard.collectedToday).toEqual({ total: "4000.00", cash: "4000.00" });
    expect(dashboard.salesToday).toMatchObject({ total: "10000.00" });
    expect(dashboard.owedByCustomers).toEqual({ total: "6000.00", customers: 1 });
    expect((await getDashboard(world.a.as.CASHIER)).owedByCustomers).toBeNull();
  });

  it("can be the whole sale, with nothing paid now", async () => {
    const result = await sell(30, { customerId: ada, credit: "3000.00" });
    expect(await owes(ada)).toBe("3000.00");
    expect((await getSale(world.a.as.ADMIN, { saleId: result.id })).payments).toEqual([]);
    expect(await getDb().payment.count()).toBe(0);
  });

  it("a named customer can also simply pay: their name is on the sale and nothing goes on their account", async () => {
    const result = await sell(5, { customerId: bola, cash: "500.00" });
    expect(await getSale(world.a.as.ADMIN, { saleId: result.id })).toMatchObject({ customer: { name: "Bola Ade" }, creditAmount: "0.00", owedAfter: null });
    expect(await owes(bola)).toBe("0.00");
    expect(await getDb().customerAccountEntry.count()).toBe(0);
  });

  it("is refused without a customer, for a customer with no credit limit, and for someone not allowed to sell on credit", async () => {
    const before = await everything();
    expect((await refusal(sell(10, { credit: "1000.00" }))).fieldErrors.creditAmount).toMatch(/walk-in customer cannot buy on credit/);
    expect((await refusal(sell(10, { customerId: bola, credit: "1000.00" }))).fieldErrors.creditAmount).toBe(
      "Bola Ade cannot buy on credit yet. An admin or manager must first give them a credit limit.",
    );
    await expect(postSale(world.a.as.ACCOUNTANT, sale(10, { customerId: ada, credit: "1000.00" }))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await everything()).toBe(before);
  });

  it("refuses bad credit amounts and payments that do not make up the rest", async () => {
    const before = await everything();
    const attempt = async (options: Options) => Object.keys((await refusal(sell(10, { customerId: ada, ...options }))).fieldErrors);
    for (const credit of ["0", "-5", "lots", "1,000", "1000.005"]) {
      expect(await attempt({ credit, cash: "1000.00" }), credit).toEqual(["creditAmount"]);
    }
    expect(await attempt({ credit: "1000.01" })).toEqual(["creditAmount"]);
    // ₦600 on credit leaves ₦400 to pay — not ₦500, not nothing.
    expect(await attempt({ credit: "600.00", cash: "500.00" })).toEqual(["payments"]);
    expect(await attempt({ credit: "600.00" })).toEqual(["payments"]);
    expect(await attempt({ credit: "1000.00", cash: "100.00" })).toEqual(["payments"]);
    expect(await everything()).toBe(before);
  });

  it("over the customer's limit is refused for a cashier and says how much room is left; a manager can allow it, and it is logged", async () => {
    await sell(150, { customerId: ada, credit: "15000.00" });
    const before = await everything();
    const error = await refusal(sell(60, { customerId: ada, credit: "6000.00" }));
    expect(error.fieldErrors.creditAmount).toBe(
      "Ada Okafor owes ₦15,000.00 and their limit is ₦20,000.00, so only ₦5,000.00 more can go on credit. A manager or admin can allow more, or raise the limit.",
    );
    expect(await everything()).toBe(before);

    // Exactly up to the limit is fine.
    await sell(50, { customerId: ada, credit: "5000.00" });
    expect(await getCustomer(world.a.as.ADMIN, { customerId: ada })).toMatchObject({ balance: "20000.00", availableCredit: "0.00" });

    const allowed = await sell(10, { customerId: ada, credit: "1000.00", as: world.a.as.MANAGER });
    expect(await owes(ada)).toBe("21000.00");
    const statement = await getCustomerStatement(world.a.as.ADMIN, { customerId: ada });
    expect(statement.lines[0]).toMatchObject({ documentNumber: allowed.receiptNumber, note: "Over the credit limit, allowed by Test a.manager." });
    const log = await getDb().activityLog.findFirstOrThrow({ where: { action: "sale.credit_over_limit" } });
    expect(log.summary).toBe(`Test a.manager let Ada Okafor go over their credit limit on sale ${allowed.receiptNumber}: ₦1,000.00 on credit, now owing ₦21,000.00.`);
    // Lowering the limit below what is owed is allowed, and simply stops further credit.
    await setCreditLimit(world.a.as.ADMIN, { customerId: ada, creditLimit: "1000" });
    expect((await refusal(sell(1, { customerId: ada, credit: "100.00" }))).fieldErrors.creditAmount).toMatch(/only ₦0.00 more can go on credit/);
  });

  it("two credit sales at the same instant cannot together take a customer over the limit", async () => {
    const second = { ...sale(120, { customerId: ada, credit: "12000.00" }) };
    const outcomes = await Promise.allSettled([sell(120, { customerId: ada, credit: "12000.00" }), postSale(world.a.as.CASHIER, second)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await owes(ada)).toBe("12000.00");
    expect(await getDb().sale.count()).toBe(1);
  });

  it("keeps the customer's name and phone on the sale as they were, whatever changes later", async () => {
    const result = await sell(1, { customerId: ada, cash: "100.00" });
    await updateCustomer(world.a.as.ADMIN, { customerId: ada, name: "Ada Nwosu", phone: "08099999999" });
    expect((await getSale(world.a.as.ADMIN, { saleId: result.id })).customer).toEqual({ id: ada, name: "Ada Okafor", phone: "08031234567" });
  });
});

describe("repayments", () => {
  it("a later repayment of ₦2,500 leaves ₦3,500, and appears on the statement and in the day's collections", async () => {
    await sell(100, { customerId: ada, credit: "6000.00", cash: "4000.00" });
    const result = await recordRepayment(world.a.as.ACCOUNTANT, repay(ada, "2500", { reference: "TRF-88", note: "Part payment" }));
    expect(result).toMatchObject({ number: 1, amount: "2500.00", balanceAfter: "3500.00", alreadySaved: false });
    expect(await owes(ada)).toBe("3500.00");

    const statement = await getCustomerStatement(world.a.as.ACCOUNTANT, { customerId: ada });
    expect(statement.lines.map((line) => [line.type, line.documentNumber, line.amount, line.balanceAfter, line.note])).toEqual([
      ["REPAYMENT", "RP-000001", "-2500.00", "3500.00", "Part payment"],
      ["CREDIT_SALE", "T1-000001", "6000.00", "6000.00", null],
    ]);
    expect((await getDashboard(world.a.as.ADMIN)).collectedToday).toEqual({ total: "6500.00", cash: "4000.00" });
    expect((await getCustomer(world.a.as.ADMIN, { customerId: ada })).unpaidSales.map((unpaid) => [unpaid.receiptNumber, unpaid.credit, unpaid.outstanding])).toEqual([
      ["T1-000001", "6000.00", "3500.00"],
    ]);
    const log = await getDb().activityLog.findFirstOrThrow({ where: { action: "repayment.recorded" } });
    expect(log.summary).toBe("Test a.accountant received ₦2,500.00 (Bank transfer) from Ada Okafor against their debt (RP-000001). They now owe ₦3,500.00.");
    expect((await listCustomers(world.a.as.ADMIN, { owing: "1" })).totalOwed).toBe("3500.00");
  });

  it("pays off the oldest sales first, unless a sale is chosen", async () => {
    const first = await sell(10, { customerId: ada, credit: "1000.00" });
    const second = await sell(20, { customerId: ada, credit: "2000.00" });
    const third = await sell(30, { customerId: ada, credit: "3000.00" });
    const outstanding = async () =>
      (await getCustomer(world.a.as.ADMIN, { customerId: ada })).unpaidSales.map((unpaid) => [unpaid.receiptNumber, unpaid.outstanding]);

    await recordRepayment(world.a.as.ADMIN, repay(ada, "1500"));
    expect(await outstanding()).toEqual([
      [second.receiptNumber, "1500.00"],
      [third.receiptNumber, "3000.00"],
    ]);
    // Chosen: the third sale is paid first; what is left over goes to the oldest.
    await recordRepayment(world.a.as.ADMIN, repay(ada, "3200", { saleId: third.id }));
    expect(await outstanding()).toEqual([[second.receiptNumber, "1300.00"]]);
    expect(await owes(ada)).toBe("1300.00");

    // A sale with nothing left to pay cannot be chosen.
    expect((await refusal(recordRepayment(world.a.as.ADMIN, repay(ada, "100", { saleId: first.id })))).fieldErrors).toHaveProperty("saleId");
    await recordRepayment(world.a.as.ADMIN, repay(ada, "1300"));
    expect(await outstanding()).toEqual([]);
    expect(await owes(ada)).toBe("0.00");
  });

  it("can never be more than what is owed: there are no advance deposits", async () => {
    await sell(10, { customerId: ada, credit: "1000.00" });
    const before = await everything();
    const error = await refusal(recordRepayment(world.a.as.ADMIN, repay(ada, "1000.01")));
    expect(error.message).toBe("Nothing was saved: Ada Okafor owes ₦1,000.00. A repayment cannot be more than that.");
    expect((await refusal(recordRepayment(world.a.as.ADMIN, repay(bola, "50")))).message).toBe("Nothing was saved: Bola Ade does not owe anything.");
    for (const amount of ["0", "-10", "some", "1,000", ""]) {
      expect((await refusal(recordRepayment(world.a.as.ADMIN, repay(ada, amount)))).fieldErrors, amount).toHaveProperty("amount");
    }
    expect(await everything()).toBe(before);
    await recordRepayment(world.a.as.ADMIN, repay(ada, "1000"));
    expect(await owes(ada)).toBe("0.00");
  });

  it("two repayments at the same instant are both recorded once and the balance is correct", async () => {
    await sell(100, { customerId: ada, credit: "10000.00" });
    const one = repay(ada, "3000");
    const results = await Promise.all([
      recordRepayment(world.a.as.ADMIN, one),
      recordRepayment(world.a.as.ACCOUNTANT, repay(ada, "2000")),
      recordRepayment(world.a.as.CASHIER, repayCash(ada, "1500")),
      // The first one again, sent twice by an impatient hand.
      recordRepayment(world.a.as.ADMIN, one),
    ]);
    expect(results.filter((result) => !result.alreadySaved)).toHaveLength(3);
    expect(await owes(ada)).toBe("3500.00");
    expect(await getDb().repayment.count()).toBe(3);
    expect((await getDb().repayment.findMany({ orderBy: { number: "asc" } })).map((repayment) => repayment.number)).toEqual([1, 2, 3]);
    // The balance after each entry steps down to what is owed now, whatever order they landed in.
    const lines = (await getCustomerStatement(world.a.as.ADMIN, { customerId: ada })).lines;
    expect(lines[0].balanceAfter).toBe("3500.00");
    expect(new Set(lines.map((line) => line.balanceAfter)).size).toBe(4);
  });

  it("two repayments at the same instant that together are more than the debt: exactly one is taken", async () => {
    await sell(10, { customerId: ada, credit: "1000.00" });
    const outcomes = await Promise.allSettled([recordRepayment(world.a.as.ADMIN, repay(ada, "700")), recordRepayment(world.a.as.ACCOUNTANT, repay(ada, "700"))]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await owes(ada)).toBe("300.00");
    expect(await getDb().repayment.count()).toBe(1);
  });

  it("in cash goes into the open till of the checkout named, and needs that till to be open; a transfer does not", async () => {
    await sell(50, { customerId: ada, credit: "5000.00" });
    const options = await getRepaymentOptions(world.a.as.ACCOUNTANT);
    expect(options.terminals).toEqual([{ id: world.a.terminalId, code: "T1", name: expect.any(String), tillOpen: true }]);
    expect(options.paymentMethods.map((method) => method.name)).toEqual(["Cash", "Bank transfer"]);

    await recordRepayment(world.a.as.ACCOUNTANT, repayCash(ada, "1200"));
    const session = await getTillSession(world.a.as.MANAGER, { sessionId: tillId });
    // Float 1,000 + cash repaid 1,200; nothing was sold for cash.
    expect(session).toMatchObject({ expectedCash: "2200.00", cashRepaid: "1200.00" });
    expect((await getTillSession(world.a.as.CASHIER, { sessionId: tillId })).cashRepaid).toBeNull();
    expect((await getDb().repayment.findFirstOrThrow()).tillSessionId).toBe(tillId);

    expect((await refusal(recordRepayment(world.a.as.ADMIN, repay(ada, "100", { methodId: world.a.cashMethodId })))).fieldErrors).toHaveProperty("terminalId");
    expect((await refusal(recordRepayment(world.a.as.ADMIN, repayCash(ada, "100", { terminalId: world.b.terminalId })))).fieldErrors).toHaveProperty("terminalId");
    expect((await refusal(recordRepayment(world.a.as.ADMIN, repayCash(ada, "100", { reference: "X" })))).fieldErrors).toHaveProperty("reference");

    await closeTill(world.a.as.MANAGER, { sessionId: tillId, countedCash: "2200" });
    const before = await everything();
    expect((await refusal(recordRepayment(world.a.as.ADMIN, repayCash(ada, "100")))).message).toMatch(/the till of T1 is not open, and the cash has to go into it/);
    expect(await everything()).toBe(before);
    await recordRepayment(world.a.as.ADMIN, repay(ada, "100"));
    expect(await owes(ada)).toBe("3700.00");
  });

  it("history cannot be changed or deleted, and the database itself keeps a balance from going below nothing", async () => {
    await sell(10, { customerId: ada, credit: "1000.00" });
    await recordRepayment(world.a.as.ADMIN, repay(ada, "400"));
    const db = getDb();
    const entry = await db.customerAccountEntry.findFirstOrThrow({ where: { type: "REPAYMENT" } });
    const repayment = await db.repayment.findFirstOrThrow();
    const allocation = await db.repaymentAllocation.findFirstOrThrow();

    await expect(db.customerAccountEntry.update({ where: { id: entry.id }, data: { amount: "-1" } })).rejects.toThrow();
    await expect(db.customerAccountEntry.delete({ where: { id: entry.id } })).rejects.toThrow();
    await expect(db.repayment.update({ where: { id: repayment.id }, data: { amount: "1" } })).rejects.toThrow();
    await expect(db.repayment.delete({ where: { id: repayment.id } })).rejects.toThrow();
    await expect(db.repaymentAllocation.update({ where: { id: allocation.id }, data: { amount: "1" } })).rejects.toThrow();
    await expect(db.repaymentAllocation.delete({ where: { id: allocation.id } })).rejects.toThrow();
    await expect(db.customer.update({ where: { id: ada }, data: { balance: { decrement: "600.01" } } })).rejects.toThrow();
    // A cash repayment with no till, and a sale with credit but no customer, cannot exist.
    await expect(db.repayment.create({ data: { ...repayment, id: randomUUID(), requestId: randomUUID(), number: 9, kind: "CASH", tillSessionId: null } })).rejects.toThrow();
    const sale = await db.sale.findFirstOrThrow();
    await expect(
      db.sale.create({ data: { ...sale, id: randomUUID(), requestId: randomUUID(), sequence: 99, receiptNumber: "T1-000099", customerId: null } }),
    ).rejects.toThrow();
  });
});

describe("cancelling a credit sale", () => {
  it("takes what it put on the account off again, with its own line on the statement", async () => {
    const kept = await sell(10, { customerId: ada, credit: "1000.00" });
    const gone = await sell(100, { customerId: ada, credit: "6000.00", cash: "4000.00" });
    expect(await owes(ada)).toBe("7000.00");

    await cancelSale(world.a.as.MANAGER, { saleId: gone.id, note: "Customer changed her mind" });
    expect(await owes(ada)).toBe("1000.00");
    const statement = await getCustomerStatement(world.a.as.ADMIN, { customerId: ada });
    expect(statement.lines.map((line) => [line.type, line.documentNumber, line.amount, line.balanceAfter])).toEqual([
      ["SALE_CANCELLED", gone.receiptNumber, "-6000.00", "1000.00"],
      ["CREDIT_SALE", gone.receiptNumber, "6000.00", "7000.00"],
      ["CREDIT_SALE", kept.receiptNumber, "1000.00", "1000.00"],
    ]);
    // Only the cash is refunded; the cancelled sale is no longer among the unpaid ones.
    expect((await getDb().refund.findMany()).map((refund) => refund.amount.toFixed(2))).toEqual(["4000.00"]);
    expect((await getCustomer(world.a.as.ADMIN, { customerId: ada })).unpaidSales.map((unpaid) => unpaid.receiptNumber)).toEqual([kept.receiptNumber]);
    expect((await getTillSession(world.a.as.MANAGER, { sessionId: tillId })).expectedCash).toBe("1000.00");
  });

  it("is refused once part of that sale's debt has been repaid", async () => {
    const sold = await sell(10, { customerId: ada, credit: "1000.00" });
    await recordRepayment(world.a.as.ADMIN, repay(ada, "300"));
    const before = await everything();
    expect((await refusal(cancelSale(world.a.as.MANAGER, { saleId: sold.id, note: "Customer changed her mind" }))).message).toMatch(
      /part of this sale's debt has already been repaid/,
    );
    expect(await everything()).toBe(before);
    expect(await getDb().saleCancellation.count()).toBe(0);
  });
});

describe("the customer list's purchases and visits (C58)", () => {
  it("shows total purchases and visits, leaves out cancelled sales, and filters and sorts by them", async () => {
    await updateCustomer(world.a.as.MANAGER, { customerId: ada, name: "Ada Okafor", phone: "08031234567", city: "Aba", state: "Abia" });
    await updateCustomer(world.a.as.MANAGER, { customerId: bola, name: "Bola Ade", phone: "08055550000", city: "Ikeja", state: "Lagos" });
    const chidi = (await createCustomer(world.a.as.CASHIER, { name: "Chidi Eze", phone: "08090000000", city: "Aba", state: "Abia" })).id;
    await sell(10, { customerId: ada, cash: "1000.00" });
    await sell(5, { customerId: ada, credit: "500.00" });
    const undone = await sell(20, { customerId: ada, cash: "2000.00" });
    await cancelSale(world.a.as.MANAGER, { saleId: undone.id, note: "Customer changed his mind" });
    await sell(40, { customerId: bola, cash: "4000.00" });
    await sell(3, { cash: "300.00" }); // A walk-in belongs to nobody.

    const list = (input: Record<string, string> = {}) => listCustomers(world.a.as.ACCOUNTANT, input);
    const rows = async (input: Record<string, string> = {}) =>
      (await list(input)).customers.map((customer) => [customer.name, customer.purchases, customer.visits]);

    expect(await rows()).toEqual([
      ["Ada Okafor", "1500.00", 2],
      ["Bola Ade", "4000.00", 1],
      ["Chidi Eze", "0.00", 0],
    ]);
    expect(await list()).toMatchObject({ total: 3, totalPurchases: "5500.00", totalOwed: "500.00", states: ["Abia", "Lagos"], showsPurchases: true });
    expect((await list()).customers[0]).toMatchObject({ city: "Aba", state: "Abia" });

    expect((await rows({ sort: "purchases" })).map((row) => row[0])).toEqual(["Bola Ade", "Ada Okafor", "Chidi Eze"]);
    expect((await rows({ sort: "visits" })).map((row) => row[0])).toEqual(["Ada Okafor", "Bola Ade", "Chidi Eze"]);
    expect((await rows({ sort: "owes" })).map((row) => row[0])).toEqual(["Ada Okafor", "Bola Ade", "Chidi Eze"]);
    expect((await rows({ sort: "nonsense" })).map((row) => row[0])).toEqual(["Ada Okafor", "Bola Ade", "Chidi Eze"]);

    expect((await rows({ state: "Abia" })).map((row) => row[0])).toEqual(["Ada Okafor", "Chidi Eze"]);
    expect((await rows({ search: "lagos" })).map((row) => row[0])).toEqual(["Bola Ade"]);
    expect((await rows({ min: "1000" })).map((row) => row[0])).toEqual(["Ada Okafor", "Bola Ade"]);
    expect((await rows({ min: "1000", max: "2000" })).map((row) => row[0])).toEqual(["Ada Okafor"]);
    expect((await rows({ max: "0" })).map((row) => row[0])).toEqual(["Chidi Eze"]);
    expect(await list({ min: "1000", max: "2000" })).toMatchObject({ total: 1, totalPurchases: "1500.00" });
    // An amount that is not a plain number is ignored rather than guessed at.
    expect(await rows({ min: "1,000" })).toHaveLength(3);

    // Within dates: only customers who bought in them, with what they bought in them.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
    expect(await rows({ from: today, to: today })).toEqual([
      ["Ada Okafor", "1500.00", 2],
      ["Bola Ade", "4000.00", 1],
    ]);
    expect(await rows({ from: "2020-01-01", to: "2020-12-31" })).toEqual([]);
    expect(await rows({ to: "2020-12-31" })).toEqual([]);
    expect(chidi).toBeTruthy();
  });

  it("is not shown to a cashier, whose filters by purchases are ignored; business B sees none of it", async () => {
    await sell(10, { customerId: ada, cash: "1000.00" });
    const seen = await listCustomers(world.a.as.CASHIER, { sort: "purchases", min: "5000", from: "2020-01-01", to: "2020-01-02" });
    expect(seen).toMatchObject({ showsPurchases: false, totalPurchases: null, total: 2 });
    expect(seen.customers.map((customer) => [customer.name, customer.purchases, customer.visits])).toEqual([
      ["Ada Okafor", null, null],
      ["Bola Ade", null, null],
    ]);
    await createCustomer(world.b.as.CASHIER, { name: "Ada Okafor", phone: "08031234567" });
    expect((await listCustomers(world.b.as.ADMIN)).customers.map((customer) => [customer.purchases, customer.visits])).toEqual([["0.00", 0]]);
  });
});
