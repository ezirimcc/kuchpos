import "server-only";
import type { AppContext } from "@/server/auth/context";
import { businessDb } from "@/server/db/scoped";
import { authorize } from "@/server/permissions";
import type { ActivityItem } from "@/server/platform/owners";

/** The activity log of the business in use, newest first. */
export async function listActivity(context: AppContext, limit = 200): Promise<ActivityItem[]> {
  authorize(context, "activityLog.view");
  return businessDb(context).activityLog.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
    select: { id: true, createdAt: true, actorName: true, actorRole: true, action: true, summary: true },
  });
}
