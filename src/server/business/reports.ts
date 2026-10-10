import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { dayToDate, shopDayEnd, shopDayStart, shopToday } from "@/lib/format";
import { moneyToString, sumMoney } from "@/lib/money";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb } from "@/server/db/scoped";
import { ValidationError } from "@/server/errors";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize, can } from "@/server/permissions";

/**
 * Reports, for the business in use (M14, C65). They only read: every figure comes from what
 * was stored when the sale, return, payment or stock movement happened, never from today's
 * prices or settings (the one exception — today's average cost for valuing stock in the past
 * — is said on screen).
 *
 * Rules every figure here follows:
 * - A cancelled sale is left out altogether.
 * - A sale belongs to the shop day it was MADE: for a sale made without internet that is the
 *   checkout computer's clock (`deviceTime`), not when it reached the server.
 * - A return belongs to the day the goods came back. Net sales = sales − refunds for returns.
 * - Cost and profit are returned only to those who may see cost prices.
 */

type Db = ReturnType<typeof businessDb>;
const ZERO = new Decimal(0);
const SHOP_OFFSET_MS = 60 * 60 * 1000; // Africa/Lagos is one hour ahead of UTC all year.
const MAX_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

const periodSchema = z.object({
  from: z.string().trim().optional().default(""),
  to: z.string().trim().optional().default(""),
});

export type Period = { from: string; to: string; days: number };
type Range = Period & { start: Date; end: Date };

/** The period asked for (whole shop days); this month so far when nothing is asked. At most a year. */
function rangeOf(input: { from: string; to: string }): Range {
  const today = shopToday();
  const to = dayToDate(input.to) ? input.to : today;
  const from = dayToDate(input.from) ? input.from : dayToDate(input.to) ? input.to.slice(0, 8) + "01" : today.slice(0, 8) + "01";
  if (from > to) throw new ValidationError("The first day of the period is after the last day.", { from: "Choose a first day on or before the last day." });
  const days = Math.round((dayToDate(to)!.getTime() - dayToDate(from)!.getTime()) / DAY_MS) + 1;
  if (days > MAX_DAYS) throw new ValidationError("A report can cover at most a year. Choose a shorter period.", { from: "At most a year." });
  return { from, to, days, start: shopDayStart(from)!, end: shopDayEnd(to)! };
}

/** The period of the same length that ends the day before this one starts. */
function before(range: Range): Range {
  const end = range.start;
  const start = new Date(end.getTime() - range.days * DAY_MS);
  const day = (moment: Date) => shopToday(moment);
  return { from: day(start), to: day(new Date(end.getTime() - 1)), days: range.days, start, end };
}

const madeIn = (range: Range): Prisma.SaleWhereInput => ({
  cancellation: null,
  OR: [
    { offline: false, createdAt: { gte: range.start, lt: range.end } },
    { offline: true, deviceTime: { gte: range.start, lt: range.end } },
  ],
});
const money = (value: { toFixed(places: number): string } | null | undefined) => new Decimal(value?.toFixed(2) ?? "0");
const percent = (part: Decimal, whole: Decimal) => (whole.greaterThan(0) ? part.times(100).dividedBy(whole).toFixed(1) : null);

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

const SALES_GROUPS = ["day", "product", "category", "cashier", "hour", "method"] as const;
export type SalesGrouping = (typeof SALES_GROUPS)[number];

export type SalesSummary = {
  salesCount: number;
  /** What the goods came to before discounts; the discounts; what customers were charged. */
  beforeDiscount: string;
  discounts: string;
  sales: string;
  returnsCount: number;
  refunds: string;
  /** Sales less refunds for returned goods. */
  netSales: string;
  /** Net sales ÷ number of sales. */
  averageSale: string | null;
  /** Lines ÷ sales. */
  itemsPerSale: string | null;
  /** Discounts ÷ sales before discount, and refunds ÷ sales, in percent. */
  discountRate: string | null;
  returnRate: string | null;
  /** Only for those who see cost prices: cost of the goods sold (less goods put back in stock), profit, and profit ÷ net sales in percent. */
  cost: string | null;
  profit: string | null;
  margin: string | null;
};

export type SalesRow = {
  key: string;
  label: string;
  salesCount: number;
  sales: string;
  refunds: string;
  net: string;
  cost: string | null;
  profit: string | null;
  margin: string | null;
};

type Bucket = { label: string; saleIds: Set<string>; sales: Decimal; refunds: Decimal; cost: Decimal };

async function salesFacts(db: Db, range: Range) {
  const [sales, returns] = await Promise.all([
    db.sale.findMany({
      where: madeIn(range),
      select: {
        id: true,
        total: true,
        discountAmount: true,
        costTotal: true,
        creditAmount: true,
        cashierUserId: true,
        cashierName: true,
        createdAt: true,
        deviceTime: true,
        offline: true,
        lines: { select: { productId: true, productName: true, lineTotal: true, discountAmount: true, lineCost: true } },
        payments: { select: { methodName: true, amount: true } },
      },
    }),
    db.saleReturn.findMany({
      where: { createdAt: { gte: range.start, lt: range.end } },
      select: {
        refundTotal: true,
        debtReduced: true,
        refundPaid: true,
        refundMethodName: true,
        restockedCost: true,
        createdAt: true,
        sale: { select: { cashierUserId: true, cashierName: true } },
        lines: { select: { productId: true, productName: true, refundAmount: true, lineCost: true, disposition: true } },
      },
    }),
  ]);
  return { sales, returns };
}

function summarise(facts: Awaited<ReturnType<typeof salesFacts>>, seesCost: boolean): SalesSummary {
  const sales = sumMoney(facts.sales.map((sale) => money(sale.total)));
  const discounts = sumMoney(facts.sales.map((sale) => money(sale.discountAmount)));
  const refunds = sumMoney(facts.returns.map((entry) => money(entry.refundTotal)));
  const net = sales.minus(refunds);
  const lines = facts.sales.reduce((count, sale) => count + sale.lines.length, 0);
  const cost = sumMoney(facts.sales.map((sale) => money(sale.costTotal))).minus(sumMoney(facts.returns.map((entry) => money(entry.restockedCost))));
  const profit = net.minus(cost);
  const count = facts.sales.length;
  return {
    salesCount: count,
    beforeDiscount: moneyToString(sales.plus(discounts)),
    discounts: moneyToString(discounts),
    sales: moneyToString(sales),
    returnsCount: facts.returns.length,
    refunds: moneyToString(refunds),
    netSales: moneyToString(net),
    averageSale: count > 0 ? net.dividedBy(count).toFixed(2) : null,
    itemsPerSale: count > 0 ? new Decimal(lines).dividedBy(count).toFixed(1) : null,
    discountRate: percent(discounts, sales.plus(discounts)),
    returnRate: percent(refunds, sales),
    cost: seesCost ? moneyToString(cost) : null,
    profit: seesCost ? moneyToString(profit) : null,
    margin: seesCost ? percent(profit, net) : null,
  };
}

const salesSchema = periodSchema.extend({ by: z.string().trim().optional().default("day") });

/** Sales, returns and what is left, for a period — in total, against the period before, and broken down one way. */
export async function getSalesReport(
  context: AppContext,
  input: unknown = {},
): Promise<{ period: Period; previous: Period; by: SalesGrouping; summary: SalesSummary; before: SalesSummary; rows: SalesRow[]; showsCost: boolean }> {
  authorize(context, "report.sales.view");
  const data = parseInput(salesSchema, input);
  const by = (SALES_GROUPS as readonly string[]).includes(data.by) ? (data.by as SalesGrouping) : "day";
  const range = rangeOf(data);
  const previous = before(range);
  const db = businessDb(context);
  const seesCost = can(context, "cost.view");
  const [facts, earlier] = await Promise.all([salesFacts(db, range), salesFacts(db, previous)]);

  const madeAt = (sale: { offline: boolean; deviceTime: Date | null; createdAt: Date }) => (sale.offline && sale.deviceTime ? sale.deviceTime : sale.createdAt);
  const hourOf = (moment: Date) => new Date(moment.getTime() + SHOP_OFFSET_MS).getUTCHours();
  const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00 – ${String(hour).padStart(2, "0")}:59`;

  let categoryOf = new Map<string, { id: string; name: string }>();
  if (by === "category") {
    const ids = [...new Set([...facts.sales.flatMap((sale) => sale.lines.map((line) => line.productId)), ...facts.returns.flatMap((entry) => entry.lines.map((line) => line.productId))])];
    const products = ids.length ? await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, category: { select: { id: true, name: true } } } }) : [];
    categoryOf = new Map(products.map((product) => [product.id, product.category ?? { id: "none", name: "No category" }]));
  }

  const buckets = new Map<string, Bucket>();
  const bucket = (key: string, label: string) => {
    let found = buckets.get(key);
    if (!found) {
      found = { label, saleIds: new Set(), sales: ZERO, refunds: ZERO, cost: ZERO };
      buckets.set(key, found);
    }
    return found;
  };
  const addSale = (key: string, label: string, saleId: string, amount: Decimal, cost: Decimal) => {
    const into = bucket(key, label);
    into.saleIds.add(saleId);
    into.sales = into.sales.plus(amount);
    into.cost = into.cost.plus(cost);
  };
  const addRefund = (key: string, label: string, amount: Decimal, costBack: Decimal) => {
    const into = bucket(key, label);
    into.refunds = into.refunds.plus(amount);
    into.cost = into.cost.minus(costBack);
  };

  for (const sale of facts.sales) {
    const whole = (key: string, label: string) => addSale(key, label, sale.id, money(sale.total), money(sale.costTotal));
    if (by === "day") whole(shopToday(madeAt(sale)), shopToday(madeAt(sale)));
    else if (by === "cashier") whole(sale.cashierUserId ?? sale.cashierName, sale.cashierName);
    else if (by === "hour") whole(String(hourOf(madeAt(sale))).padStart(2, "0"), hourLabel(hourOf(madeAt(sale))));
    else if (by === "method") {
      for (const payment of sale.payments) addSale(payment.methodName, payment.methodName, sale.id, money(payment.amount), ZERO);
      if (money(sale.creditAmount).greaterThan(0)) addSale("~credit", "On credit (to pay later)", sale.id, money(sale.creditAmount), ZERO);
    } else {
      for (const line of sale.lines) {
        const fetched = money(line.lineTotal).minus(money(line.discountAmount));
        const group = by === "product" ? { id: line.productId, name: line.productName } : (categoryOf.get(line.productId) ?? { id: "none", name: "No category" });
        addSale(group.id, group.name, sale.id, fetched, money(line.lineCost));
      }
    }
  }
  for (const entry of facts.returns) {
    const whole = (key: string, label: string) => addRefund(key, label, money(entry.refundTotal), money(entry.restockedCost));
    if (by === "day") whole(shopToday(entry.createdAt), shopToday(entry.createdAt));
    else if (by === "cashier") whole(entry.sale.cashierUserId ?? entry.sale.cashierName, entry.sale.cashierName);
    else if (by === "hour") whole(String(hourOf(entry.createdAt)).padStart(2, "0"), hourLabel(hourOf(entry.createdAt)));
    else if (by === "method") {
      if (money(entry.refundPaid).greaterThan(0)) addRefund(entry.refundMethodName ?? "Other", entry.refundMethodName ?? "Other", money(entry.refundPaid), ZERO);
      if (money(entry.debtReduced).greaterThan(0)) addRefund("~credit", "On credit (to pay later)", money(entry.debtReduced), ZERO);
    } else {
      for (const line of entry.lines) {
        const group = by === "product" ? { id: line.productId, name: line.productName } : (categoryOf.get(line.productId) ?? { id: "none", name: "No category" });
        addRefund(group.id, group.name, money(line.refundAmount), line.disposition === "WRITTEN_OFF" ? ZERO : money(line.lineCost));
      }
    }
  }

  // Days and hours in their own order; everything else, the biggest first.
  const ordered = [...buckets.entries()].sort(([keyA, a], [keyB, b]) =>
    by === "day" || by === "hour" ? keyA.localeCompare(keyB) : b.sales.minus(b.refunds).comparedTo(a.sales.minus(a.refunds)) || a.label.localeCompare(b.label),
  );
  const withCost = seesCost && by !== "method";
  return {
    period: { from: range.from, to: range.to, days: range.days },
    previous: { from: previous.from, to: previous.to, days: previous.days },
    by,
    showsCost: withCost,
    summary: summarise(facts, seesCost),
    before: summarise(earlier, seesCost),
    rows: ordered.map(([key, entry]) => {
      const net = entry.sales.minus(entry.refunds);
      const profit = net.minus(entry.cost);
      return {
        key,
        label: entry.label,
        salesCount: entry.saleIds.size,
        sales: moneyToString(entry.sales),
        refunds: moneyToString(entry.refunds),
        net: moneyToString(net),
        cost: withCost ? moneyToString(entry.cost) : null,
        profit: withCost ? moneyToString(profit) : null,
        margin: withCost ? percent(profit, net) : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Collections: money actually received
// ---------------------------------------------------------------------------

export type CollectionRow = {
  methodName: string;
  kind: string;
  /** Received for sales, and against customers' debts. */
  fromSales: string;
  fromDebts: string;
  /** Given back: for cancelled sales, and for returned goods. */
  refunded: string;
  net: string;
};

/**
 * Money received in a period, by payment method: for sales and against debts, less what was
 * given back for cancelled sales and returned goods. Unlike the sales report, this follows
 * the money: a sale put on credit appears here only when it is repaid.
 */
export async function getCollectionsReport(
  context: AppContext,
  input: unknown = {},
): Promise<{ period: Period; rows: CollectionRow[]; totals: Omit<CollectionRow, "methodName" | "kind">; cashNet: string }> {
  authorize(context, "report.collections.view");
  const range = rangeOf(parseInput(periodSchema, input));
  const db = businessDb(context);
  const inRange = { gte: range.start, lt: range.end };
  const [payments, repayments, refunds, returns] = await Promise.all([
    // A payment is received when its sale is made (for an offline sale, by the checkout's clock).
    db.payment.findMany({
      where: { OR: [{ sale: { offline: false }, createdAt: inRange }, { sale: { offline: true, deviceTime: inRange } }] },
      select: { methodName: true, kind: true, amount: true },
    }),
    db.repayment.groupBy({ by: ["methodName", "kind"], where: { createdAt: inRange }, _sum: { amount: true } }),
    db.refund.groupBy({ by: ["methodName", "kind"], where: { createdAt: inRange }, _sum: { amount: true } }),
    db.saleReturn.groupBy({ by: ["refundMethodName", "refundKind"], where: { createdAt: inRange, refundKind: { not: null } }, _sum: { refundPaid: true } }),
  ]);
  const rows = new Map<string, { methodName: string; kind: string; fromSales: Decimal; fromDebts: Decimal; refunded: Decimal }>();
  const row = (methodName: string, kind: string) => {
    const key = `${kind}|${methodName}`;
    let found = rows.get(key);
    if (!found) {
      found = { methodName, kind, fromSales: ZERO, fromDebts: ZERO, refunded: ZERO };
      rows.set(key, found);
    }
    return found;
  };
  for (const payment of payments) {
    const into = row(payment.methodName, payment.kind);
    into.fromSales = into.fromSales.plus(money(payment.amount));
  }
  for (const group of repayments) row(group.methodName, group.kind).fromDebts = row(group.methodName, group.kind).fromDebts.plus(money(group._sum.amount));
  for (const group of refunds) row(group.methodName, group.kind).refunded = row(group.methodName, group.kind).refunded.plus(money(group._sum.amount));
  for (const group of returns) {
    const into = row(group.refundMethodName ?? "Other", group.refundKind ?? "TRANSFER");
    into.refunded = into.refunded.plus(money(group._sum.refundPaid));
  }
  const listed = [...rows.values()].sort((a, b) => (a.kind === "CASH" ? -1 : 0) - (b.kind === "CASH" ? -1 : 0) || a.methodName.localeCompare(b.methodName));
  const net = (entry: { fromSales: Decimal; fromDebts: Decimal; refunded: Decimal }) => entry.fromSales.plus(entry.fromDebts).minus(entry.refunded);
  const total = {
    fromSales: sumMoney(listed.map((entry) => entry.fromSales)),
    fromDebts: sumMoney(listed.map((entry) => entry.fromDebts)),
    refunded: sumMoney(listed.map((entry) => entry.refunded)),
  };
  return {
    period: { from: range.from, to: range.to, days: range.days },
    rows: listed.map((entry) => ({
      methodName: entry.methodName,
      kind: entry.kind,
      fromSales: moneyToString(entry.fromSales),
      fromDebts: moneyToString(entry.fromDebts),
      refunded: moneyToString(entry.refunded),
      net: moneyToString(net(entry)),
    })),
    totals: { fromSales: moneyToString(total.fromSales), fromDebts: moneyToString(total.fromDebts), refunded: moneyToString(total.refunded), net: moneyToString(net(total)) },
    cashNet: moneyToString(sumMoney(listed.filter((entry) => entry.kind === "CASH").map(net))),
  };
}

// ---------------------------------------------------------------------------
// Customer debts, by age
// ---------------------------------------------------------------------------

export type DebtRow = {
  customerId: string;
  name: string;
  phone: string;
  creditLimit: string | null;
  /** What is owed, by how long ago the goods were bought: up to 30 days, 31–60, 61–90, and longer. */
  current: string;
  days31: string;
  days61: string;
  older: string;
  total: string;
  /** The oldest sale still not fully paid. */
  oldestSale: Date | null;
};

/** Who owes what, and for how long: every customer with a debt, the longest-owed first. */
export async function getDebtReport(context: AppContext): Promise<{ rows: DebtRow[]; totals: Pick<DebtRow, "current" | "days31" | "days61" | "older" | "total"> }> {
  authorize(context, "report.customerDebt.view");
  const db = businessDb(context);
  const customers = await db.customer.findMany({
    where: { balance: { gt: 0 } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, phone: true, balance: true, creditLimit: true },
  });
  const ids = customers.map((customer) => customer.id);
  const sales = ids.length
    ? await db.sale.findMany({
        where: { customerId: { in: ids }, creditAmount: { gt: 0 }, cancellation: null },
        select: { id: true, customerId: true, creditAmount: true, createdAt: true, deviceTime: true, offline: true },
      })
    : [];
  const saleIds = sales.map((sale) => sale.id);
  const [paid, returned] = saleIds.length
    ? await Promise.all([
        db.repaymentAllocation.groupBy({ by: ["saleId"], where: { saleId: { in: saleIds } }, _sum: { amount: true } }),
        db.saleReturn.groupBy({ by: ["saleId"], where: { saleId: { in: saleIds }, debtReduced: { gt: 0 } }, _sum: { debtReduced: true } }),
      ])
    : [[], []];
  const settled = new Map<string, Decimal>();
  for (const group of paid) settled.set(group.saleId, money(group._sum.amount));
  for (const group of returned) settled.set(group.saleId, (settled.get(group.saleId) ?? ZERO).plus(money(group._sum.debtReduced)));

  const now = Date.now();
  const rows = customers.map((customer) => {
    const ages = { current: ZERO, days31: ZERO, days61: ZERO, older: ZERO };
    let oldest: Date | null = null;
    for (const sale of sales) {
      if (sale.customerId !== customer.id) continue;
      const owed = money(sale.creditAmount).minus(settled.get(sale.id) ?? ZERO);
      if (!owed.greaterThan(0)) continue;
      const made = sale.offline && sale.deviceTime ? sale.deviceTime : sale.createdAt;
      const age = Math.floor((now - made.getTime()) / DAY_MS);
      const key = age <= 30 ? "current" : age <= 60 ? "days31" : age <= 90 ? "days61" : "older";
      ages[key] = ages[key].plus(owed);
      if (!oldest || made < oldest) oldest = made;
    }
    return { customer, ...ages, oldest };
  });
  rows.sort((a, b) => (a.oldest?.getTime() ?? now) - (b.oldest?.getTime() ?? now) || a.customer.name.localeCompare(b.customer.name));
  const sum = (key: "current" | "days31" | "days61" | "older") => sumMoney(rows.map((entry) => entry[key]));
  return {
    rows: rows.map((entry) => ({
      customerId: entry.customer.id,
      name: entry.customer.name,
      phone: entry.customer.phone,
      creditLimit: entry.customer.creditLimit?.toFixed(2) ?? null,
      current: moneyToString(entry.current),
      days31: moneyToString(entry.days31),
      days61: moneyToString(entry.days61),
      older: moneyToString(entry.older),
      total: entry.customer.balance.toFixed(2),
      oldestSale: entry.oldest,
    })),
    totals: {
      current: moneyToString(sum("current")),
      days31: moneyToString(sum("days31")),
      days61: moneyToString(sum("days61")),
      older: moneyToString(sum("older")),
      total: moneyToString(sumMoney(customers.map((customer) => money(customer.balance)))),
    },
  };
}

// ---------------------------------------------------------------------------
// Stock movements
// ---------------------------------------------------------------------------

const MOVEMENT_TYPES = ["RECEIPT", "RECEIPT_CORRECTION", "TRANSFER_OUT", "TRANSFER_IN", "ADJUSTMENT", "SALE", "SALE_CANCELLATION", "SALE_RETURN"] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

const movementsSchema = periodSchema.extend({
  search: z.string().trim().max(120).optional().default(""),
  type: z.string().trim().optional().default(""),
  location: z.string().trim().optional().default(""),
  page: pageNumber,
  /** For an export: every row that matches, not one page. */
  all: z.boolean().optional().default(false),
});

export type MovementRow = {
  id: string;
  at: Date;
  productName: string;
  productCode: string | null;
  baseUnitName: string;
  locationName: string;
  type: MovementType;
  /** In the product's base unit; negative when stock left. */
  quantity: string;
  documentNumber: string;
  userName: string;
};

const EXPORT_LIMIT = 20_000;

/** Every movement of stock in a period — in, out and between places — newest first. */
export async function getStockMovements(
  context: AppContext,
  input: unknown = {},
): Promise<{ period: Period; rows: MovementRow[]; locations: { id: string; name: string }[] } & Paged> {
  authorize(context, "report.stock.view");
  const data = parseInput(movementsSchema, input);
  const range = rangeOf(data);
  const db = businessDb(context);
  const where: Prisma.StockMovementWhereInput = {
    createdAt: { gte: range.start, lt: range.end },
    ...((MOVEMENT_TYPES as readonly string[]).includes(data.type) ? { type: data.type as MovementType } : {}),
    ...(/^[0-9a-f-]{36}$/i.test(data.location) ? { locationId: data.location } : {}),
    ...(data.search
      ? { OR: [{ product: { name: { contains: data.search } } }, { product: { code: { contains: data.search } } }, { documentNumber: { contains: data.search } }] }
      : {}),
  };
  const [total, rows, locations] = await Promise.all([
    db.stockMovement.count({ where }),
    db.stockMovement.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(data.all ? { take: EXPORT_LIMIT } : { skip: (data.page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
      include: {
        product: { select: { name: true, code: true, units: { where: { isBase: true }, select: { name: true } } } },
        location: { select: { name: true } },
      },
    }),
    db.location.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return {
    period: { from: range.from, to: range.to, days: range.days },
    locations,
    rows: rows.map((row) => ({
      id: row.id,
      at: row.createdAt,
      productName: row.product.name,
      productCode: row.product.code,
      baseUnitName: row.product.units[0]?.name ?? "",
      locationName: row.location.name,
      type: row.type,
      quantity: row.quantityDelta.toFixed(3),
      documentNumber: row.documentNumber,
      userName: row.userName,
    })),
    ...paged(total, data.page),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const exportSchema = z.object({ report: z.enum(["sales", "collections", "debts", "stock-movements"]) }).passthrough();

export type ReportExport = { filename: string; header: string[]; rows: (string | number | null)[][] };

/**
 * One of the reports above as a table for a CSV file. Needs the right to export AND the
 * right to read that report; it calls the same operation the screen does, so the file can
 * never hold more than the screen would show that person.
 */
export async function exportReport(context: AppContext, input: unknown): Promise<ReportExport> {
  authorize(context, "report.export");
  const { report, ...filters } = parseInput(exportSchema, input);
  const stamp = (period: Period) => `${period.from}_to_${period.to}`;
  const iso = (moment: Date | null) => (moment ? new Date(moment.getTime() + SHOP_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ") : "");

  if (report === "sales") {
    const data = await getSalesReport(context, filters);
    const titles: Record<SalesGrouping, string> = { day: "Day", product: "Product", category: "Category", cashier: "Cashier", hour: "Hour", method: "Paid by" };
    return {
      filename: `sales-by-${data.by}_${stamp(data.period)}.csv`,
      header: [titles[data.by], "Sales (count)", "Sales", "Refunds for returns", "Net sales", ...(data.showsCost ? ["Cost", "Profit", "Margin %"] : [])],
      rows: data.rows.map((row) => [row.label, row.salesCount, row.sales, row.refunds, row.net, ...(data.showsCost ? [row.cost, row.profit, row.margin] : [])]),
    };
  }
  if (report === "collections") {
    const data = await getCollectionsReport(context, filters);
    return {
      filename: `collections_${stamp(data.period)}.csv`,
      header: ["Paid by", "Received for sales", "Received against debts", "Given back", "Net received"],
      rows: [
        ...data.rows.map((row) => [row.methodName, row.fromSales, row.fromDebts, row.refunded, row.net]),
        ["Total", data.totals.fromSales, data.totals.fromDebts, data.totals.refunded, data.totals.net],
      ],
    };
  }
  if (report === "debts") {
    const data = await getDebtReport(context);
    return {
      filename: `customer-debts_${shopToday()}.csv`,
      header: ["Customer", "Phone", "Credit limit", "0-30 days", "31-60 days", "61-90 days", "Over 90 days", "Owes in all", "Oldest unpaid sale"],
      rows: data.rows.map((row) => [row.name, row.phone, row.creditLimit, row.current, row.days31, row.days61, row.older, row.total, iso(row.oldestSale).slice(0, 10)]),
    };
  }
  const data = await getStockMovements(context, { ...filters, all: true });
  return {
    filename: `stock-movements_${stamp(data.period)}.csv`,
    header: ["When", "Product", "Code", "Place", "What", "Quantity", "Unit", "Document", "By"],
    rows: data.rows.map((row) => [iso(row.at), row.productName, row.productCode, row.locationName, row.type, row.quantity, row.baseUnitName, row.documentNumber, row.userName]),
  };
}
