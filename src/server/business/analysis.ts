import "server-only";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import { shopToday } from "@/lib/format";
import { moneyToString, sumMoney } from "@/lib/money";
import { quantityToString } from "@/lib/quantity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { madeIn, type Period, periodSchema, rangeOf } from "@/server/business/reports";
import { businessDb } from "@/server/db/scoped";
import { NotFoundError } from "@/server/errors";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize } from "@/server/permissions";

/**
 * Analysis beside the everyday screens (C70): the top fives on the home page, what one
 * customer has bought, and how one product has sold. Like the reports, these only read, and
 * only what was stored when each sale was made.
 *
 * The same rules as the sales report: cancelled sales are left out; a sale belongs to the
 * shop day it was made; and amounts are what the goods actually fetched — the line's price
 * less its share of any discount — less what was refunded for goods returned.
 */

const SHOP_OFFSET_MS = 60 * 60 * 1000; // Africa/Lagos is one hour ahead of UTC all year.
const DAY_MS = 24 * 60 * 60 * 1000;
const TOP = 5;
const money = (value: { toFixed(places: number): string } | null | undefined) => new Decimal(value?.toFixed(2) ?? "0");
const amountOf = (value: { toFixed(places: number): string }) => new Decimal(value.toFixed(3));
const madeAt = (sale: { offline: boolean; deviceTime: Date | null; createdAt: Date }) => (sale.offline && sale.deviceTime ? sale.deviceTime : sale.createdAt);

/** What a sale line really fetched and how much of it stayed sold, after any goods returned from it. */
function netOfLine(line: {
  lineTotal: { toFixed(places: number): string };
  discountAmount: { toFixed(places: number): string };
  baseQuantity: { toFixed(places: number): string };
  returnLines: { refundAmount: { toFixed(places: number): string }; baseQuantity: { toFixed(places: number): string } }[];
}): { amount: Decimal; quantity: Decimal } {
  return {
    amount: money(line.lineTotal).minus(money(line.discountAmount)).minus(sumMoney(line.returnLines.map((entry) => money(entry.refundAmount)))),
    quantity: line.returnLines.reduce((left, entry) => left.minus(amountOf(entry.baseQuantity)), amountOf(line.baseQuantity)),
  };
}

// ---------------------------------------------------------------------------
// The home page
// ---------------------------------------------------------------------------

export type TopRow = { key: string; label: string; amount: string };
export type HomeAnalysis = { period: Period; products: TopRow[]; categories: TopRow[]; customers: TopRow[] };

/**
 * The five products, five categories and five customers with the highest net sales in a
 * period — for admins and owners.
 *
 * The rules are the sales report's (by product, by category) and the customers list's
 * (purchases in the period): sales made in the period less refunds for goods that came back
 * in it. A test holds the two to the same figures. But the adding up is done by the DATABASE
 * here, in six small questions, instead of calling those reports: they read every sale and
 * line of the period and work out much more than a top five, and on the hosting server —
 * which allows the app five database connections — that made the home page slow, and stall
 * when someone clicked from one period to the next.
 */
export async function getHomeAnalysis(context: AppContext, input: unknown = {}): Promise<HomeAnalysis> {
  authorize(context, "dashboard.analysis.view");
  const range = rangeOf(parseInput(periodSchema, input));
  const db = businessDb(context);
  const made = madeIn(range);
  const cameBack = { gte: range.start, lt: range.end };

  // One after another on purpose: the page around this is asking its own questions at the
  // same moment, and there are only a few connections to go round.
  const sold = await db.saleLine.groupBy({ by: ["productId"], where: { sale: made }, _sum: { lineTotal: true, discountAmount: true } });
  const returned = await db.saleReturnLine.groupBy({ by: ["productId"], where: { return: { createdAt: cameBack } }, _sum: { refundAmount: true } });
  const bought = await db.sale.groupBy({ by: ["customerId"], where: { ...made, customerId: { not: null } }, _sum: { total: true } });
  const refunded = await db.saleReturn.groupBy({ by: ["customerId"], where: { createdAt: cameBack, customerId: { not: null } }, _sum: { refundTotal: true } });

  const perProduct = new Map<string, Decimal>();
  for (const group of sold) perProduct.set(group.productId, money(group._sum.lineTotal).minus(money(group._sum.discountAmount)));
  for (const group of returned) perProduct.set(group.productId, (perProduct.get(group.productId) ?? new Decimal(0)).minus(money(group._sum.refundAmount)));
  const perCustomer = new Map<string, Decimal>();
  for (const group of bought) if (group.customerId) perCustomer.set(group.customerId, money(group._sum.total));
  for (const group of refunded) {
    // As on the customers list: what came back is taken off, but never below nothing.
    if (group.customerId && perCustomer.has(group.customerId)) {
      perCustomer.set(group.customerId, Decimal.max(perCustomer.get(group.customerId)!.minus(money(group._sum.refundTotal)), 0));
    }
  }

  const products = perProduct.size > 0 ? await db.product.findMany({ where: { id: { in: [...perProduct.keys()] } }, select: { id: true, name: true, category: { select: { id: true, name: true } } } }) : [];
  const topCustomers = [...perCustomer.entries()].filter(([, amount]) => amount.greaterThan(0));
  const customers = topCustomers.length > 0 ? await db.customer.findMany({ where: { id: { in: topCustomers.map(([id]) => id) } }, select: { id: true, name: true } }) : [];

  const perCategory = new Map<string, { label: string; amount: Decimal }>();
  for (const product of products) {
    // Under the category the product is in today, as in the sales report.
    const category = product.category ?? { id: "none", name: "No category" };
    const entry = perCategory.get(category.id) ?? { label: category.name, amount: new Decimal(0) };
    entry.amount = entry.amount.plus(perProduct.get(product.id) ?? 0);
    perCategory.set(category.id, entry);
  }
  // The largest first; of equals, by name — the same order the report and the list use.
  const top = (rows: { key: string; label: string; amount: Decimal }[]): TopRow[] =>
    rows
      .filter((row) => row.amount.greaterThan(0))
      .sort((a, b) => b.amount.comparedTo(a.amount) || a.label.localeCompare(b.label))
      .slice(0, TOP)
      .map((row) => ({ key: row.key, label: row.label, amount: moneyToString(row.amount) }));
  const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));

  return {
    period: { from: range.from, to: range.to, days: range.days },
    products: top(products.map((product) => ({ key: product.id, label: product.name, amount: perProduct.get(product.id) ?? new Decimal(0) }))),
    categories: top([...perCategory.entries()].map(([key, entry]) => ({ key, ...entry }))),
    customers: top(topCustomers.map(([key, amount]) => ({ key, label: customerName.get(key) ?? "", amount }))),
  };
}

// ---------------------------------------------------------------------------
// One customer
// ---------------------------------------------------------------------------

export type CustomerPurchases = {
  customer: { id: string; name: string };
  period: Period;
  /** In the whole period: how many purchases, what they came to after returns, and what was returned. */
  salesCount: number;
  spent: string;
  /** What they bought, the most spent on first. Quantities are in each product's smallest unit. */
  products: { productId: string; name: string; unitName: string; quantity: string; amount: string }[];
  /** The purchases themselves, newest first, a page at a time. */
  sales: { id: string; receiptNumber: string; at: Date; items: number; total: string; onCredit: string; refunded: string }[];
} & Paged;

const customerSchema = periodSchema.extend({ customerId: z.string().uuid("That customer could not be found."), page: pageNumber });

/** What one customer bought in a period: each purchase, and each product with the quantity and the amount spent on it. */
export async function getCustomerPurchases(context: AppContext, input: unknown): Promise<CustomerPurchases> {
  authorize(context, "customer.purchases.view");
  const data = parseInput(customerSchema, input);
  const range = rangeOf(data);
  const db = businessDb(context);
  const customer = await db.customer.findFirst({ where: { id: data.customerId }, select: { id: true, name: true } });
  if (!customer) throw new NotFoundError("That customer could not be found.");

  const theirs = { customerId: customer.id, ...madeIn(range) };
  const [salesCount, sales, lines] = await Promise.all([
    db.sale.count({ where: theirs }),
    db.sale.findMany({
      where: theirs,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (data.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        receiptNumber: true,
        createdAt: true,
        deviceTime: true,
        offline: true,
        total: true,
        creditAmount: true,
        _count: { select: { lines: true } },
        returns: { select: { refundTotal: true } },
      },
    }),
    db.saleLine.findMany({
      where: { sale: theirs },
      orderBy: { sale: { createdAt: "asc" } },
      select: { productId: true, productName: true, baseQuantity: true, lineTotal: true, discountAmount: true, returnLines: { select: { refundAmount: true, baseQuantity: true } } },
    }),
  ]);

  const bought = new Map<string, { name: string; quantity: Decimal; amount: Decimal }>();
  for (const line of lines) {
    const net = netOfLine(line);
    const entry = bought.get(line.productId) ?? { name: line.productName, quantity: new Decimal(0), amount: new Decimal(0) };
    // The name the product had on the latest purchase.
    bought.set(line.productId, { name: line.productName, quantity: entry.quantity.plus(net.quantity), amount: entry.amount.plus(net.amount) });
  }
  const baseUnits = bought.size > 0 ? await db.productUnit.findMany({ where: { productId: { in: [...bought.keys()] }, isBase: true }, select: { productId: true, name: true } }) : [];
  const unitOf = new Map(baseUnits.map((unit) => [unit.productId, unit.name]));
  const products = [...bought.entries()]
    .map(([productId, entry]) => ({ productId, ...entry }))
    .sort((a, b) => b.amount.comparedTo(a.amount) || a.name.localeCompare(b.name));

  return {
    customer,
    period: { from: range.from, to: range.to, days: range.days },
    salesCount,
    spent: moneyToString(sumMoney(products.map((product) => product.amount))),
    products: products.map((product) => ({
      productId: product.productId,
      name: product.name,
      unitName: unitOf.get(product.productId) ?? "",
      quantity: quantityToString(product.quantity),
      amount: moneyToString(product.amount),
    })),
    sales: sales.map((sale) => ({
      id: sale.id,
      receiptNumber: sale.receiptNumber,
      at: madeAt(sale),
      items: sale._count.lines,
      total: sale.total.toFixed(2),
      onCredit: sale.creditAmount.toFixed(2),
      refunded: moneyToString(sumMoney(sale.returns.map((entry) => money(entry.refundTotal)))),
    })),
    ...paged(salesCount, data.page),
  };
}

// ---------------------------------------------------------------------------
// One product
// ---------------------------------------------------------------------------

/** How the line over time is cut up: by the hour for one day, by the day up to three months, by the month beyond. */
export type SalesGrain = "hour" | "day" | "month";

export type ProductSales = {
  product: { id: string; name: string; unitName: string };
  period: Period;
  grain: SalesGrain;
  /** Every hour, day or month of the period in order, including those with nothing sold. */
  series: { key: string; amount: string; quantity: string }[];
  salesCount: number;
  amount: string;
  quantity: string;
  /** Who bought it, the biggest buyer first. Sales with no customer named are gathered under one line (customerId null). */
  customers: { customerId: string | null; name: string; quantity: string; amount: string; salesCount: number; lastSale: { id: string; receiptNumber: string; at: Date } }[];
  /** Each time it was sold, newest first (the latest 200). */
  purchases: { saleId: string; receiptNumber: string; at: Date; customerId: string | null; customerName: string | null; sold: string; unitName: string; amount: string }[];
};

const productSchema = periodSchema.extend({ productId: z.string().uuid("That product could not be found.") });
const MAX_PURCHASES_SHOWN = 200;

/**
 * How one product sold in a period: the amount and quantity over time, the customers who
 * bought it with how much each bought, and each sale of it.
 */
export async function getProductSales(context: AppContext, input: unknown): Promise<ProductSales> {
  authorize(context, "report.sales.view");
  authorize(context, "report.pages.view");
  const data = parseInput(productSchema, input);
  const range = rangeOf(data);
  const db = businessDb(context);
  const product = await db.product.findFirst({ where: { id: data.productId }, select: { id: true, name: true, units: { where: { isBase: true }, select: { name: true } } } });
  if (!product) throw new NotFoundError("That product could not be found.");

  const lines = await db.saleLine.findMany({
    where: { productId: product.id, sale: madeIn(range) },
    select: {
      quantity: true,
      unitName: true,
      baseQuantity: true,
      lineTotal: true,
      discountAmount: true,
      returnLines: { select: { refundAmount: true, baseQuantity: true } },
      sale: { select: { id: true, receiptNumber: true, createdAt: true, deviceTime: true, offline: true, customerId: true, customerName: true } },
    },
  });

  const grain: SalesGrain = range.days === 1 ? "hour" : range.days <= 92 ? "day" : "month";
  const keyOf = (moment: Date) => {
    if (grain === "hour") return String(new Date(moment.getTime() + SHOP_OFFSET_MS).getUTCHours()).padStart(2, "0");
    return grain === "day" ? shopToday(moment) : shopToday(moment).slice(0, 7);
  };
  // Every hour, day or month of the period, so that a time with no sales shows as nothing rather than being skipped.
  const buckets = new Map<string, { amount: Decimal; quantity: Decimal }>();
  const empty = () => ({ amount: new Decimal(0), quantity: new Decimal(0) });
  if (grain === "hour") for (let hour = 0; hour < 24; hour += 1) buckets.set(String(hour).padStart(2, "0"), empty());
  else {
    for (let moment = new Date(`${range.from}T00:00:00.000Z`).getTime(); moment <= new Date(`${range.to}T00:00:00.000Z`).getTime(); moment += DAY_MS) {
      const day = new Date(moment).toISOString().slice(0, 10);
      const key = grain === "day" ? day : day.slice(0, 7);
      if (!buckets.has(key)) buckets.set(key, empty());
    }
  }

  const buyers = new Map<string, { customerId: string | null; name: string; quantity: Decimal; amount: Decimal; saleIds: Set<string>; lastSale: { id: string; receiptNumber: string; at: Date } }>();
  const saleIds = new Set<string>();
  const sold = lines
    .map((line) => ({ line, net: netOfLine(line), at: madeAt(line.sale) }))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  for (const { line, net, at } of sold) {
    saleIds.add(line.sale.id);
    const bucket = buckets.get(keyOf(at));
    if (bucket) {
      bucket.amount = bucket.amount.plus(net.amount);
      bucket.quantity = bucket.quantity.plus(net.quantity);
    }
    const who = line.sale.customerId ?? "";
    const buyer = buyers.get(who) ?? {
      customerId: line.sale.customerId,
      name: line.sale.customerId ? (line.sale.customerName ?? "") : "Customers not named (walk-in)",
      quantity: new Decimal(0),
      amount: new Decimal(0),
      saleIds: new Set<string>(),
      // The list is newest first, so the first sale met is the latest.
      lastSale: { id: line.sale.id, receiptNumber: line.sale.receiptNumber, at },
    };
    buyer.quantity = buyer.quantity.plus(net.quantity);
    buyer.amount = buyer.amount.plus(net.amount);
    buyer.saleIds.add(line.sale.id);
    buyers.set(who, buyer);
  }

  return {
    product: { id: product.id, name: product.name, unitName: product.units[0]?.name ?? "" },
    period: { from: range.from, to: range.to, days: range.days },
    grain,
    series: [...buckets.entries()].map(([key, bucket]) => ({ key, amount: moneyToString(bucket.amount), quantity: quantityToString(bucket.quantity) })),
    salesCount: saleIds.size,
    amount: moneyToString(sumMoney(sold.map((entry) => entry.net.amount))),
    quantity: quantityToString(sold.reduce((sum, entry) => sum.plus(entry.net.quantity), new Decimal(0))),
    customers: [...buyers.values()]
      .sort((a, b) => b.amount.comparedTo(a.amount) || a.name.localeCompare(b.name))
      .map((buyer) => ({
        customerId: buyer.customerId,
        name: buyer.name,
        quantity: quantityToString(buyer.quantity),
        amount: moneyToString(buyer.amount),
        salesCount: buyer.saleIds.size,
        lastSale: buyer.lastSale,
      })),
    purchases: sold.slice(0, MAX_PURCHASES_SHOWN).map(({ line, net, at }) => ({
      saleId: line.sale.id,
      receiptNumber: line.sale.receiptNumber,
      at,
      customerId: line.sale.customerId,
      customerName: line.sale.customerName,
      sold: line.quantity.toFixed(3),
      unitName: line.unitName,
      amount: moneyToString(net.amount),
    })),
  };
}
