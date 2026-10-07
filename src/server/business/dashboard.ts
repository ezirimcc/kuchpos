import "server-only";
import { shopDayStart, shopToday } from "@/lib/format";
import type { AppContext } from "@/server/auth/context";
import { businessDb } from "@/server/db/scoped";
import { authorize, can } from "@/server/permissions";
import type { ActivityItem } from "@/server/platform/owners";

/**
 * The snapshot figures on the home dashboard. Everyone in the business gets the
 * catalogue figures; each further figure is included only if the person's role may
 * see the screen it comes from (null otherwise).
 */
export type DashboardSnapshot = {
  products: number;
  categories: number;
  /** Tax rate in percent as text with 2 decimal places. */
  taxRatePercent: string;
  /** Active staff accounts — admins and owners only. */
  staff: number | null;
  /** Activity log entries since the start of the shop's day — those who may view the log. */
  activityToday: number | null;
  recentActivity: ActivityItem[] | null;
  /** Stock adjustments waiting for a decision — those who may approve them. */
  adjustmentsWaiting: number | null;
  /**
   * Sales since the start of the shop's day: every sale for those who may see the sales
   * report, the person's own for a cashier, nothing for anyone else.
   */
  salesToday: { count: number; total: string; ownOnly: boolean } | null;
};

export async function getDashboard(context: AppContext): Promise<DashboardSnapshot> {
  authorize(context, "price.view");
  const db = businessDb(context);
  const seesStaff = can(context, "staff.manage");
  const seesActivity = can(context, "activityLog.view");
  const startOfToday = shopDayStart(shopToday()) ?? new Date();

  const seesAllSales = can(context, "report.sales.view");
  const seesSales = seesAllSales || can(context, "report.ownShift.view");

  const [products, categories, business, staff, activityToday, recentActivity, adjustmentsWaiting, salesToday] = await Promise.all([
    db.product.count({ where: { deactivatedAt: null } }),
    db.category.count(),
    db.business.findFirst({ select: { taxRatePercent: true } }),
    seesStaff ? db.user.count({ where: { disabledAt: null } }) : null,
    seesActivity ? db.activityLog.count({ where: { createdAt: { gte: startOfToday } } }) : null,
    seesActivity
      ? db.activityLog.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 6,
          select: { id: true, createdAt: true, actorName: true, actorRole: true, action: true, summary: true },
        })
      : null,
    can(context, "stock.adjust.approve") ? db.stockAdjustment.count({ where: { decision: null } }) : null,
    seesSales
      ? db.sale.aggregate({
          where: { createdAt: { gte: startOfToday }, ...(seesAllSales ? {} : { cashierUserId: context.actor.userId }) },
          _count: { _all: true },
          _sum: { total: true },
        })
      : null,
  ]);

  return {
    products,
    categories,
    taxRatePercent: business?.taxRatePercent.toFixed(2) ?? "0.00",
    staff,
    activityToday,
    recentActivity,
    adjustmentsWaiting,
    salesToday: salesToday
      ? { count: salesToday._count._all, total: salesToday._sum.total?.toFixed(2) ?? "0.00", ownOnly: !seesAllSales }
      : null,
  };
}
