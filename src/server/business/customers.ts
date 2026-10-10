import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { repaymentNumber, shopDayEnd, shopDayStart } from "@/lib/format";
import { formatNaira, moneyToString, parseMoney, sumMoney } from "@/lib/money";
import type { PaymentKindValue } from "@/lib/payment-kinds";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { takeDocumentNumber } from "@/server/document-number";
import { NotFoundError, ValidationError } from "@/server/errors";
import { optionalText } from "@/server/input";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize, can } from "@/server/permissions";

/**
 * Customers of the business in use, what they owe, and their repayments.
 *
 * A customer's debt is a history that only grows (`customer_account_entry`, add-only):
 * a credit sale adds to it, a repayment or a cancelled credit sale takes from it.
 * `customer.balance` is the running total, changed only in the same transaction as the
 * entry that explains the change, and always equal to the sum of the entries.
 *
 * There are no advance deposits (SPEC C54): a customer never owes less than nothing, so a
 * repayment larger than the debt is refused. A customer with no credit limit cannot buy on
 * credit at all (C55).
 *
 * Every change to a customer's balance — here, in postSale and in cancelSale — takes the
 * customer's row first, so two of them at the same moment queue up rather than collide.
 */

const MAX_MONEY = new Decimal("99999999999.99");
/** How many times to try again when the database reports that two savers got in each other's way. */
const MAX_ATTEMPTS = 3;
const FIX_FIELDS = "Nothing was saved. Please correct the highlighted fields.";
const NOT_FOUND = "That customer could not be found.";

// ---------------------------------------------------------------------------
// Customer records
// ---------------------------------------------------------------------------

const nameSchema = z.string().trim().min(2, "Enter the customer's name.").max(120, "The name is too long (120 characters at most).");

/** Spaces, dashes and brackets are dropped; what is left must be 7 to 15 digits, with an optional leading +. */
const phoneSchema = z
  .string()
  .transform((value) => value.replace(/[\s\-().]/g, ""))
  .pipe(z.string().regex(/^\+?\d{7,15}$/, "Enter the phone number in digits, for example 08031234567."));

const detailsSchema = z.object({
  name: nameSchema,
  phone: phoneSchema,
  address: optionalText(200, "The address is too long (200 characters at most).").optional().default(""),
  city: optionalText(60, "The city is too long (60 characters at most).").optional().default(""),
  state: optionalText(60, "The state is too long (60 characters at most).").optional().default(""),
});

const customerIdSchema = z.object({ customerId: z.string().uuid(NOT_FOUND) });

function phoneTaken(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
const PHONE_TAKEN = { phone: "Another customer of this business already has that phone number." };

export type CustomerSummary = {
  id: string;
  name: string;
  phone: string;
  city: string | null;
  state: string | null;
  /** What the customer owes now. */
  balance: string;
  /** Empty means this customer cannot buy on credit. */
  creditLimit: string | null;
  active: boolean;
  /**
   * What the customer has bought (sales not cancelled; within the dates asked for, if any)
   * and on how many sales. Null for people who may not read customer statements.
   */
  purchases: string | null;
  visits: number | null;
};

const CUSTOMER_SORTS = ["name", "purchases", "visits", "owes"] as const;

const listSchema = z.object({
  search: z.string().trim().max(120).optional().default(""),
  /** "1" to show only customers who owe something. */
  owing: z.string().optional().default(""),
  state: z.string().trim().max(60).optional().default(""),
  /** Purchases and visits are counted within these shop days; only customers who bought in them are shown. */
  from: z.string().trim().optional().default(""),
  to: z.string().trim().optional().default(""),
  /** Total purchases at least / at most this much. */
  min: z.string().trim().optional().default(""),
  max: z.string().trim().optional().default(""),
  sort: z.string().trim().optional().default("name"),
  page: pageNumber,
});

/** A typed amount for a "from … to …" filter; anything that is not a plain amount is ignored. */
function amountOrNull(text: string): Decimal | null {
  try {
    return text === "" ? null : parseMoney(text);
  } catch {
    return null;
  }
}

/**
 * One page of customers with what each owes — and, for those who may read statements, what
 * each has bought and how often — plus the totals for all who match.
 */
export async function listCustomers(
  context: AppContext,
  input: unknown = {},
): Promise<
  {
    customers: CustomerSummary[];
    totalOwed: string;
    /** Total bought by all who match; null when purchases are not shown to this person. */
    totalPurchases: string | null;
    /** The states customers are recorded in, for the filter. */
    states: string[];
    canManage: boolean;
    showsPurchases: boolean;
  } & Paged
> {
  authorize(context, "customer.balance.view");
  const data = parseInput(listSchema, input);
  const { search, owing, page } = data;
  const digits = search.replace(/[\s\-().]/g, "");
  const showsPurchases = can(context, "customer.statement.view");

  const where: Prisma.CustomerWhereInput = {
    ...(owing === "1" ? { balance: { gt: 0 } } : {}),
    ...(data.state ? { state: data.state } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search } },
            { city: { contains: search } },
            { state: { contains: search } },
            ...(/^\+?\d+$/.test(digits) ? [{ phone: { contains: digits } }] : []),
          ],
        }
      : {}),
  };
  const db = businessDb(context);
  const [rows, stateRows] = await Promise.all([
    db.customer.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, phone: true, city: true, state: true, balance: true, creditLimit: true, deactivatedAt: true },
    }),
    db.customer.findMany({ where: { state: { not: null } }, distinct: ["state"], orderBy: { state: "asc" }, select: { state: true } }),
  ]);

  // What each has bought: the sales that still stand, within the dates asked for.
  const from = showsPurchases ? shopDayStart(data.from) : null;
  const to = showsPurchases ? shopDayEnd(data.to) : null;
  const bought = new Map<string, { purchases: Decimal; visits: number }>();
  if (showsPurchases && rows.length > 0) {
    const sums = await db.sale.groupBy({
      by: ["customerId"],
      where: {
        customerId: { not: null },
        cancellation: null,
        ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
      },
      _sum: { total: true },
      _count: { _all: true },
    });
    for (const sum of sums) {
      if (sum.customerId) bought.set(sum.customerId, { purchases: new Decimal((sum._sum.total ?? new Decimal(0)).toFixed(2)), visits: sum._count._all });
    }
    // What came back is not a purchase: refunds for returned goods (in the same dates) are taken off.
    const back = await db.saleReturn.groupBy({
      by: ["customerId"],
      where: { customerId: { not: null }, ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}) },
      _sum: { refundTotal: true },
    });
    for (const group of back) {
      const entry = group.customerId ? bought.get(group.customerId) : undefined;
      if (entry) entry.purchases = Decimal.max(entry.purchases.minus(group._sum.refundTotal?.toFixed(2) ?? "0"), 0);
    }
  }
  const nothing = { purchases: new Decimal(0), visits: 0 };
  const min = showsPurchases ? amountOrNull(data.min) : null;
  const max = showsPurchases ? amountOrNull(data.max) : null;
  let matching = rows.map((row) => ({ row, ...(bought.get(row.id) ?? nothing) }));
  if (from || to) matching = matching.filter((entry) => entry.visits > 0);
  if (min) matching = matching.filter((entry) => entry.purchases.greaterThanOrEqualTo(min));
  if (max) matching = matching.filter((entry) => entry.purchases.lessThanOrEqualTo(max));

  // Already in name order; the other orders put the biggest first and keep names as the tie-break.
  const sort = (CUSTOMER_SORTS as readonly string[]).includes(data.sort) ? data.sort : "name";
  if (sort === "purchases" && showsPurchases) matching.sort((one, other) => other.purchases.comparedTo(one.purchases));
  if (sort === "visits" && showsPurchases) matching.sort((one, other) => other.visits - one.visits);
  if (sort === "owes") matching.sort((one, other) => new Decimal(other.row.balance.toFixed(2)).comparedTo(one.row.balance.toFixed(2)));

  return {
    canManage: can(context, "customer.manage"),
    showsPurchases,
    states: stateRows.map((entry) => entry.state).filter((state): state is string => !!state),
    totalOwed: moneyToString(sumMoney(matching.map((entry) => new Decimal(entry.row.balance.toFixed(2))))),
    totalPurchases: showsPurchases ? moneyToString(sumMoney(matching.map((entry) => entry.purchases))) : null,
    customers: matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(({ row, purchases, visits }) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      city: row.city,
      state: row.state,
      balance: row.balance.toFixed(2),
      creditLimit: row.creditLimit?.toFixed(2) ?? null,
      active: row.deactivatedAt === null,
      purchases: showsPurchases ? moneyToString(purchases) : null,
      visits: showsPurchases ? visits : null,
    })),
    ...paged(matching.length, page),
  };
}

export async function createCustomer(context: AppContext, input: unknown): Promise<{ id: string }> {
  authorize(context, "customer.manage");
  const businessId = businessIdOf(context);
  const data = parseInput(detailsSchema, input);

  try {
    return await businessDb(context).$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: { businessId, name: data.name, phone: data.phone, address: data.address || null, city: data.city || null, state: data.state || null },
      });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "customer.created",
          summary: `${context.actor.name} added the customer "${customer.name}" (${customer.phone}).`,
          targetType: "customer",
          targetId: customer.id,
        }),
      });
      return { id: customer.id };
    });
  } catch (error) {
    if (phoneTaken(error)) throw new ValidationError(FIX_FIELDS, PHONE_TAKEN);
    throw error;
  }
}

const updateSchema = detailsSchema.extend({ customerId: z.string().uuid(NOT_FOUND) });

/** Changes a customer's contact details. Past sales keep the name and phone they were made under. */
export async function updateCustomer(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "customer.manage");
  const data = parseInput(updateSchema, input);

  try {
    await businessDb(context).$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: data.customerId } });
      if (!customer) throw new NotFoundError(NOT_FOUND);
      const next = { name: data.name, phone: data.phone, address: data.address || null, city: data.city || null, state: data.state || null };
      if ((Object.keys(next) as (keyof typeof next)[]).every((key) => customer[key] === next[key])) return;

      await tx.customer.update({ where: { id: customer.id }, data: next });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "customer.updated",
          summary: `${context.actor.name} changed the details of the customer "${customer.name}".`,
          targetType: "customer",
          targetId: customer.id,
          details: { was: { name: customer.name, phone: customer.phone }, now: { name: next.name, phone: next.phone } },
        }),
      });
    });
  } catch (error) {
    if (phoneTaken(error)) throw new ValidationError(FIX_FIELDS, PHONE_TAKEN);
    throw error;
  }
}

const setActiveSchema = z.object({ customerId: z.string().uuid(NOT_FOUND), active: z.boolean() });

/**
 * Takes a customer out of use (no longer offered at checkout) or brings them back.
 * A customer is never deleted, and one who still owes money can still repay.
 */
export async function setCustomerActive(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "customer.manage");
  const data = parseInput(setActiveSchema, input);

  await businessDb(context).$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({ where: { id: data.customerId } });
    if (!customer) throw new NotFoundError(NOT_FOUND);
    if ((customer.deactivatedAt === null) === data.active) return;

    await tx.customer.update({ where: { id: customer.id }, data: { deactivatedAt: data.active ? null : new Date() } });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: data.active ? "customer.reactivated" : "customer.deactivated",
        summary: `${context.actor.name} ${data.active ? "brought back" : "took out of use"} the customer "${customer.name}".`,
        targetType: "customer",
        targetId: customer.id,
      }),
    });
  });
}

const creditLimitSchema = z.object({
  customerId: z.string().uuid(NOT_FOUND),
  /** Empty means "no credit": the customer cannot buy on credit. */
  creditLimit: z.string().trim(),
});

/**
 * Sets the most a customer may owe, or (empty) that they may not buy on credit at all.
 * Admins, managers and owners only. Every change is kept in a history.
 * Lowering the limit below what the customer already owes is allowed: it stops further credit.
 */
export async function setCreditLimit(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "customer.setCreditLimit");
  const businessId = businessIdOf(context);
  const data = parseInput(creditLimitSchema, input);

  let limit: Decimal | null = null;
  if (data.creditLimit !== "") {
    try {
      limit = parseMoney(data.creditLimit);
      if (limit.isNegative() || limit.greaterThan(MAX_MONEY)) throw new Error("out of range");
    } catch {
      throw new ValidationError(FIX_FIELDS, {
        creditLimit: "Enter the limit as a plain amount, for example 50000 — or leave it empty for no credit.",
      });
    }
  }
  const show = (value: Decimal | null) => (value ? formatNaira(value) : "no credit");

  await businessDb(context).$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({ where: { id: data.customerId } });
    if (!customer) throw new NotFoundError(NOT_FOUND);
    const old = customer.creditLimit ? new Decimal(customer.creditLimit.toFixed(2)) : null;
    if ((old === null && limit === null) || (old !== null && limit !== null && old.equals(limit))) return;

    // Only succeeds if the limit is still what was just read; otherwise someone else changed it.
    const updated = await tx.customer.updateMany({
      where: { id: customer.id, creditLimit: customer.creditLimit },
      data: { creditLimit: limit ? moneyToString(limit) : null },
    });
    if (updated.count !== 1) {
      throw new ValidationError("Someone else changed this customer's credit limit a moment ago. Check it and try again.");
    }
    await tx.creditLimitChange.create({
      data: {
        businessId,
        customerId: customer.id,
        oldLimit: old ? moneyToString(old) : null,
        newLimit: limit ? moneyToString(limit) : null,
        changedByUserId: context.actor.userId,
        changedByName: context.actor.name,
      },
    });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "customer.credit_limit_changed",
        summary: `${context.actor.name} changed the credit limit of "${customer.name}" from ${show(old)} to ${show(limit)}.`,
        targetType: "customer",
        targetId: customer.id,
        details: { from: old ? moneyToString(old) : null, to: limit ? moneyToString(limit) : null },
      }),
    });
  });
}

// ---------------------------------------------------------------------------
// One customer: details, what is unpaid, and the statement
// ---------------------------------------------------------------------------

export type CustomerDetail = Omit<CustomerSummary, "purchases" | "visits"> & {
  address: string | null;
  state: string | null;
  /** How much more the customer may take on credit; null when they have no credit. */
  availableCredit: string | null;
  canManage: boolean;
  canSetCreditLimit: boolean;
  canRecordRepayment: boolean;
  /** True when this person may see the statement and the unpaid sales (a cashier sees the balance only). */
  canSeeStatement: boolean;
  /** Credit sales not yet fully repaid, oldest first. Empty for those who see the balance only. */
  unpaidSales: { saleId: string; receiptNumber: string; soldAt: Date; credit: string; outstanding: string }[];
  /** Changes of the credit limit, newest first. Empty for those who see the balance only. */
  limitHistory: { id: string; createdAt: Date; oldLimit: string | null; newLimit: string | null; changedByName: string }[];
};

type Tx = Parameters<Parameters<ReturnType<typeof businessDb>["$transaction"]>[0]>[0];

/** A customer's credit sales that are not fully repaid, oldest first, with what is still owed on each. */
async function unpaidSalesOf(db: Pick<Tx, "sale" | "repaymentAllocation" | "saleReturn">, customerId: string) {
  const sales = await db.sale.findMany({
    where: { customerId, creditAmount: { gt: 0 }, cancellation: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, receiptNumber: true, createdAt: true, creditAmount: true },
  });
  if (sales.length === 0) return [];
  const paid = await db.repaymentAllocation.groupBy({
    by: ["saleId"],
    where: { saleId: { in: sales.map((sale) => sale.id) } },
    _sum: { amount: true },
  });
  const paidOf = new Map(paid.map((group) => [group.saleId, new Decimal(group._sum.amount?.toFixed(2) ?? "0")]));
  // Goods that came back took their refund off the debt of the sale they came from.
  const returned = await db.saleReturn.groupBy({
    by: ["saleId"],
    where: { saleId: { in: sales.map((sale) => sale.id) }, debtReduced: { gt: 0 } },
    _sum: { debtReduced: true },
  });
  for (const group of returned) {
    paidOf.set(group.saleId, (paidOf.get(group.saleId) ?? new Decimal(0)).plus(group._sum.debtReduced?.toFixed(2) ?? "0"));
  }
  return sales
    .map((sale) => {
      const credit = new Decimal(sale.creditAmount.toFixed(2));
      return { saleId: sale.id, receiptNumber: sale.receiptNumber, soldAt: sale.createdAt, credit, outstanding: credit.minus(paidOf.get(sale.id) ?? 0) };
    })
    .filter((sale) => sale.outstanding.greaterThan(0));
}

export async function getCustomer(context: AppContext, input: unknown): Promise<CustomerDetail> {
  authorize(context, "customer.balance.view");
  const { customerId } = parseInput(customerIdSchema, input);
  const db = businessDb(context);

  const row = await db.customer.findFirst({ where: { id: customerId } });
  if (!row) throw new NotFoundError(NOT_FOUND);
  const seesStatement = can(context, "customer.statement.view");
  const [unpaid, history] = await Promise.all([
    seesStatement ? unpaidSalesOf(db, row.id) : [],
    seesStatement ? db.creditLimitChange.findMany({ where: { customerId: row.id }, orderBy: { createdAt: "desc" }, take: 20 }) : [],
  ]);
  const limit = row.creditLimit ? new Decimal(row.creditLimit.toFixed(2)) : null;
  const balance = new Decimal(row.balance.toFixed(2));

  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    city: row.city,
    state: row.state,
    balance: moneyToString(balance),
    creditLimit: limit ? moneyToString(limit) : null,
    availableCredit: limit ? moneyToString(Decimal.max(limit.minus(balance), 0)) : null,
    active: row.deactivatedAt === null,
    canManage: can(context, "customer.manage"),
    canSetCreditLimit: can(context, "customer.setCreditLimit"),
    canRecordRepayment: can(context, "repayment.record"),
    canSeeStatement: seesStatement,
    unpaidSales: unpaid.map((sale) => ({
      saleId: sale.saleId,
      receiptNumber: sale.receiptNumber,
      soldAt: sale.soldAt,
      credit: moneyToString(sale.credit),
      outstanding: moneyToString(sale.outstanding),
    })),
    limitHistory: history.map((change) => ({
      id: change.id,
      createdAt: change.createdAt,
      oldLimit: change.oldLimit?.toFixed(2) ?? null,
      newLimit: change.newLimit?.toFixed(2) ?? null,
      changedByName: change.changedByName,
    })),
  };
}

export type StatementLine = {
  id: string;
  createdAt: Date;
  type: "CREDIT_SALE" | "REPAYMENT" | "SALE_CANCELLED" | "SALE_RETURN";
  documentNumber: string;
  /** The sale it belongs to, for linking; null for a repayment. */
  saleId: string | null;
  note: string | null;
  /** Positive: the customer owed more. Negative: the customer owed less. */
  amount: string;
  balanceAfter: string;
  createdByName: string;
};

const statementSchema = z.object({ customerId: z.string().uuid(NOT_FOUND), page: pageNumber });

/** A customer's account, newest first: every credit sale, repayment and cancellation, with the balance after each. */
export async function getCustomerStatement(context: AppContext, input: unknown): Promise<{ lines: StatementLine[] } & Paged> {
  authorize(context, "customer.statement.view");
  const { customerId, page } = parseInput(statementSchema, input);
  const db = businessDb(context);

  const customer = await db.customer.findFirst({ where: { id: customerId }, select: { id: true } });
  if (!customer) throw new NotFoundError(NOT_FOUND);
  const where = { customerId: customer.id };
  const [total, rows] = await Promise.all([
    db.customerAccountEntry.count({ where }),
    db.customerAccountEntry.findMany({
      where,
      // Entries of one customer are written one at a time, so the time they were written orders them.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);
  return {
    lines: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      type: row.type,
      documentNumber: row.documentNumber,
      saleId: row.saleId,
      note: row.note,
      amount: row.amount.toFixed(2),
      balanceAfter: row.balanceAfter.toFixed(2),
      createdByName: row.createdByName,
    })),
    ...paged(total, page),
  };
}

// ---------------------------------------------------------------------------
// Repayments
// ---------------------------------------------------------------------------

export type RepaymentOptions = {
  paymentMethods: { id: string; name: string; kind: PaymentKindValue }[];
  /** Checkout terminals in use and whether each one's till is open: cash goes into an open till. */
  terminals: { id: string; code: string; name: string; tillOpen: boolean }[];
};

export async function getRepaymentOptions(context: AppContext): Promise<RepaymentOptions> {
  authorize(context, "repayment.record");
  const db = businessDb(context);
  const [paymentMethods, terminals, openTills] = await Promise.all([
    db.paymentMethod.findMany({
      where: { deactivatedAt: null },
      orderBy: [{ builtIn: "desc" }, { name: "asc" }],
      select: { id: true, name: true, kind: true },
    }),
    db.terminal.findMany({ where: { deactivatedAt: null }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    db.tillSession.findMany({ where: { close: null }, select: { terminalId: true } }),
  ]);
  return {
    paymentMethods,
    terminals: terminals.map((terminal) => ({ ...terminal, tillOpen: openTills.some((till) => till.terminalId === terminal.id) })),
  };
}

const repaymentSchema = z.object({
  requestId: z.string().uuid("This form has expired. Reload the page and enter the repayment again."),
  customerId: z.string().uuid(NOT_FOUND),
  amount: z.string().trim(),
  methodId: z.string().uuid("Choose how the money was paid."),
  reference: optionalText(60, "The reference is too long (60 characters at most).").optional().default(""),
  /** The checkout whose till the cash goes into. Needed only for cash. */
  terminalId: z.string().trim().optional().default(""),
  /** A sale to pay off first; whatever is left goes to the oldest unpaid sales. */
  saleId: z.string().trim().optional().default(""),
  note: optionalText(300, "The note is too long (300 characters at most).").optional().default(""),
});

export type RepaymentResult = { id: string; number: number; amount: string; balanceAfter: string; alreadySaved: boolean };

/**
 * Records money received from a customer against what they owe — part of it or all of it,
 * never more (there are no advance deposits). It pays off the sale chosen, if one is, and
 * then the oldest unpaid sales. Cash goes into the open till of the checkout named.
 *
 * The repayment, the account entry, the new balance and which sales it paid off are saved
 * together or not at all. `requestId` makes a repeated submission harmless.
 */
export async function recordRepayment(context: AppContext, input: unknown): Promise<RepaymentResult> {
  authorize(context, "repayment.record");
  const businessId = businessIdOf(context);
  const data = parseInput(repaymentSchema, input);
  const db = businessDb(context);

  const alreadySaved = async (): Promise<RepaymentResult | null> => {
    const saved = await db.repayment.findFirst({
      where: { requestId: data.requestId },
      select: { id: true, number: true, amount: true, entry: { select: { balanceAfter: true } } },
    });
    return saved
      ? { id: saved.id, number: saved.number, amount: saved.amount.toFixed(2), balanceAfter: saved.entry?.balanceAfter.toFixed(2) ?? "0.00", alreadySaved: true }
      : null;
  };
  const repeat = await alreadySaved();
  if (repeat) return repeat;

  const fieldErrors: Record<string, string> = {};
  const [customer, method] = await Promise.all([
    db.customer.findFirst({ where: { id: data.customerId }, select: { id: true, name: true } }),
    db.paymentMethod.findFirst({ where: { id: data.methodId }, select: { id: true, name: true, kind: true, deactivatedAt: true } }),
  ]);
  if (!customer) throw new NotFoundError(NOT_FOUND);
  if (!method) fieldErrors.methodId = "Choose how the money was paid.";
  else if (method.deactivatedAt) fieldErrors.methodId = `"${method.name}" is switched off. Choose another way to pay.`;

  let amount: Decimal | null = null;
  try {
    amount = parseMoney(data.amount);
    if (!amount.greaterThan(0) || amount.greaterThan(MAX_MONEY)) throw new Error("out of range");
  } catch {
    amount = null;
    fieldErrors.amount = "Enter the amount received as a plain number greater than zero, for example 5000 or 5000.50 (no commas).";
  }

  const isCash = method?.kind === "CASH";
  let terminal: { id: string; code: string } | null = null;
  if (isCash) {
    terminal = await db.terminal.findFirst({ where: { id: data.terminalId, deactivatedAt: null }, select: { id: true, code: true } });
    if (!terminal) fieldErrors.terminalId = "Choose the checkout whose till the cash is going into.";
    if (data.reference) fieldErrors.reference = "A cash payment has no reference.";
  }
  if (!method || !amount || Object.keys(fieldErrors).length > 0) throw new ValidationError(FIX_FIELDS, fieldErrors);
  const received = amount;

  const save = () =>
    db.$transaction(
      async (tx) => {
        // Cash: the terminal's "turn" first, as for a sale, and its till must be open.
        let tillSessionId: string | null = null;
        if (terminal) {
          await tx.terminal.update({ where: { id: terminal.id }, data: { updatedAt: new Date() }, select: { id: true } });
          const till = await tx.tillSession.findFirst({ where: { terminalId: terminal.id, close: null }, select: { id: true } });
          if (!till) {
            throw new ValidationError(`Nothing was saved: the till of ${terminal.code} is not open, and the cash has to go into it. Open the till first.`, {
              terminalId: "The till of this checkout is not open.",
            });
          }
          tillSessionId = till.id;
        }
        const number = await takeDocumentNumber(tx, businessId, "REPAYMENT");

        // Taken off the balance only if that much is owed — one statement, so two repayments
        // at the same moment can never take a customer below nothing. It also takes the
        // customer's "turn": everything that changes this customer's debt queues up here.
        const lowered = await tx.customer.updateMany({
          where: { id: customer.id, balance: { gte: moneyToString(received) } },
          data: { balance: { decrement: moneyToString(received) } },
        });
        const now = await tx.customer.findFirst({ where: { id: customer.id }, select: { balance: true } });
        const balance = new Decimal(now?.balance.toFixed(2) ?? "0");
        if (lowered.count !== 1) {
          throw new ValidationError(
            balance.isZero()
              ? `Nothing was saved: ${customer.name} does not owe anything.`
              : `Nothing was saved: ${customer.name} owes ${formatNaira(balance)}. A repayment cannot be more than that.`,
            { amount: balance.isZero() ? "This customer does not owe anything." : `The most that can be received is ${formatNaira(balance)}.` },
          );
        }

        // Which sales it pays off: the one chosen first, then the oldest.
        const unpaid = await unpaidSalesOf(tx, customer.id);
        if (data.saleId) {
          const chosen = unpaid.findIndex((sale) => sale.saleId === data.saleId);
          if (chosen < 0) {
            throw new ValidationError("Nothing was saved: that sale has nothing left to pay. Reload the page.", {
              saleId: "This sale has nothing left to pay.",
            });
          }
          unpaid.unshift(...unpaid.splice(chosen, 1));
        }
        let left = received;
        const allocations: { saleId: string; amount: Decimal }[] = [];
        for (const sale of unpaid) {
          if (!left.greaterThan(0)) break;
          const part = Decimal.min(left, sale.outstanding);
          allocations.push({ saleId: sale.saleId, amount: part });
          left = left.minus(part);
        }

        const repayment = await tx.repayment.create({
          data: {
            businessId,
            requestId: data.requestId,
            number,
            customerId: customer.id,
            customerName: customer.name,
            amount: moneyToString(received),
            methodId: method.id,
            methodName: method.name,
            kind: method.kind,
            reference: data.reference || null,
            tillSessionId,
            note: data.note || null,
            receivedByUserId: context.actor.userId,
            receivedByName: context.actor.name,
          },
        });
        await tx.customerAccountEntry.create({
          data: {
            businessId,
            customerId: customer.id,
            type: "REPAYMENT",
            amount: moneyToString(received.negated()),
            balanceAfter: moneyToString(balance),
            repaymentId: repayment.id,
            documentNumber: repaymentNumber(number),
            note: data.note || null,
            createdByUserId: context.actor.userId,
            createdByName: context.actor.name,
          },
        });
        if (allocations.length > 0) {
          await tx.repaymentAllocation.createMany({
            data: allocations.map((part) => ({ businessId, repaymentId: repayment.id, saleId: part.saleId, amount: moneyToString(part.amount) })),
          });
        }
        await tx.activityLog.create({
          data: activityRow(context, {
            action: "repayment.recorded",
            summary:
              `${context.actor.name} received ${formatNaira(received)} (${method.name}) from ${customer.name} against their debt ` +
              `(${repaymentNumber(number)}). They now owe ${formatNaira(balance)}.`,
            targetType: "customer",
            targetId: customer.id,
            details: { number, amount: moneyToString(received), balanceAfter: moneyToString(balance) },
          }),
        });

        return { id: repayment.id, number, amount: moneyToString(received), balanceAfter: moneyToString(balance), alreadySaved: false };
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );

  for (let attempt = 1; ; attempt++) {
    try {
      return await save();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
      // The same submission arrived twice at the same moment: return the one that was saved.
      if (known === "P2002") {
        const saved = await alreadySaved();
        if (saved) return saved;
      }
      if (known === "P2034" && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}
