import "server-only";
import { z } from "zod";
import { Decimal } from "@/lib/decimal";
import { dayToDate, shopDayEnd, shopDayStart, shopToday } from "@/lib/format";
import { moneyToString, sumMoney } from "@/lib/money";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { getDb } from "@/server/db/client";
import { ValidationError } from "@/server/errors";
import { authorize } from "@/server/permissions";

/**
 * The owner's overview: every business side by side (SPEC §4.6, C65).
 *
 * THE ONE PLACE that reads across businesses. It is for owners only, and it only ever
 * returns FIGURES PER BUSINESS — one row each, added up inside the database by business —
 * never a list in which rows of different businesses are mixed. Nothing here writes.
 * The figures follow the same rules as each business's own reports (see
 * src/server/business/reports.ts): cancelled sales left out, a sale counted on the day it
 * was made, net sales = sales − refunds for returns.
 */

const MAX_DAYS = 5 * 366;
const DAY_MS = 24 * 60 * 60 * 1000;

const schema = z.object({
  from: z.string().trim().optional().default(""),
  to: z.string().trim().optional().default(""),
});

export type OverviewRow = {
  businessId: string;
  name: string;
  active: boolean;
  salesCount: number;
  sales: string;
  refunds: string;
  netSales: string;
  /** Money received: for sales and against debts, less what was given back. */
  collected: string;
  /** What customers owe that business today. */
  owed: string;
  customersOwing: number;
};

export async function getOwnerOverview(
  context: AppContext,
  input: unknown = {},
): Promise<{ period: { from: string; to: string; days: number }; rows: OverviewRow[]; totals: Pick<OverviewRow, "salesCount" | "sales" | "refunds" | "netSales" | "collected" | "owed"> }> {
  authorize(context, "business.manage");
  const data = parseInput(schema, input);
  const today = shopToday();
  const to = dayToDate(data.to) ? data.to : today;
  const from = dayToDate(data.from) ? data.from : `${to.slice(0, 8)}01`;
  if (from > to) throw new ValidationError("The first day of the period is after the last day.");
  const days = Math.round((dayToDate(to)!.getTime() - dayToDate(from)!.getTime()) / DAY_MS) + 1;
  if (days > MAX_DAYS) throw new ValidationError("The overview can cover at most five years. Choose a shorter period.");
  const inRange = { gte: shopDayStart(from)!, lt: shopDayEnd(to)! };

  const db = getDb();
  const made = { OR: [{ offline: false, createdAt: inRange }, { offline: true, deviceTime: inRange }] };
  const [businesses, sales, returns, payments, repayments, refunds, debts] = await Promise.all([
    db.business.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, deactivatedAt: true } }),
    db.sale.groupBy({ by: ["businessId"], where: { cancellation: null, ...made }, _sum: { total: true }, _count: { _all: true } }),
    db.saleReturn.groupBy({ by: ["businessId"], where: { createdAt: inRange }, _sum: { refundTotal: true, refundPaid: true } }),
    db.payment.groupBy({
      by: ["businessId"],
      where: { OR: [{ sale: { offline: false }, createdAt: inRange }, { sale: { offline: true, deviceTime: inRange } }] },
      _sum: { amount: true },
    }),
    db.repayment.groupBy({ by: ["businessId"], where: { createdAt: inRange }, _sum: { amount: true } }),
    db.refund.groupBy({ by: ["businessId"], where: { createdAt: inRange }, _sum: { amount: true } }),
    db.customer.groupBy({ by: ["businessId"], where: { balance: { gt: 0 } }, _sum: { balance: true }, _count: { _all: true } }),
  ]);
  const amount = (value: { toFixed(places: number): string } | null | undefined) => new Decimal(value?.toFixed(2) ?? "0");
  const of = <T extends { businessId: string }>(groups: T[], businessId: string) => groups.find((group) => group.businessId === businessId);

  const rows = businesses.map((business) => {
    const sold = of(sales, business.id);
    const back = of(returns, business.id);
    const salesTotal = amount(sold?._sum.total);
    const refunded = amount(back?._sum.refundTotal);
    const collected = amount(of(payments, business.id)?._sum.amount)
      .plus(amount(of(repayments, business.id)?._sum.amount))
      .minus(amount(of(refunds, business.id)?._sum.amount))
      .minus(amount(back?._sum.refundPaid));
    const owing = of(debts, business.id);
    return {
      business,
      salesCount: sold?._count._all ?? 0,
      sales: salesTotal,
      refunds: refunded,
      net: salesTotal.minus(refunded),
      collected,
      owed: amount(owing?._sum.balance),
      customersOwing: owing?._count._all ?? 0,
    };
  });
  return {
    period: { from, to, days },
    rows: rows.map((row) => ({
      businessId: row.business.id,
      name: row.business.name,
      active: row.business.deactivatedAt === null,
      salesCount: row.salesCount,
      sales: moneyToString(row.sales),
      refunds: moneyToString(row.refunds),
      netSales: moneyToString(row.net),
      collected: moneyToString(row.collected),
      owed: moneyToString(row.owed),
      customersOwing: row.customersOwing,
    })),
    totals: {
      salesCount: rows.reduce((sum, row) => sum + row.salesCount, 0),
      sales: moneyToString(sumMoney(rows.map((row) => row.sales))),
      refunds: moneyToString(sumMoney(rows.map((row) => row.refunds))),
      netSales: moneyToString(sumMoney(rows.map((row) => row.net))),
      collected: moneyToString(sumMoney(rows.map((row) => row.collected))),
      owed: moneyToString(sumMoney(rows.map((row) => row.owed))),
    },
  };
}
