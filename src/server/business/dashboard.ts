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
};

export async function getDashboard(context: AppContext): Promise<DashboardSnapshot> {
  authorize(context, "price.view");
  const db = businessDb(context);
  const seesStaff = can(context, "staff.manage");
  const seesActivity = can(context, "activityLog.view");
  const startOfToday = shopDayStart(shopToday()) ?? new Date();

  const [products, categories, business, staff, activityToday, recentActivity] = await Promise.all([
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
  ]);

  return {
    products,
    categories,
    taxRatePercent: business?.taxRatePercent.toFixed(2) ?? "0.00",
    staff,
    activityToday,
    recentActivity,
  };
}
