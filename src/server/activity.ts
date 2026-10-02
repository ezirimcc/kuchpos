import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { AppContext } from "./auth/context";

export type ActivityEntry = {
  action: string;
  summary: string;
  targetType?: string;
  targetId?: string;
  details?: Prisma.InputJsonValue;
};

/** The columns every activity row needs about the person who acted. */
export function activityRow(context: AppContext, entry: ActivityEntry) {
  return {
    actorUserId: context.actor.userId,
    actorName: context.actor.name,
    actorRole: context.actor.role,
    action: entry.action,
    summary: entry.summary,
    targetType: entry.targetType,
    targetId: entry.targetId,
    details: entry.details,
  };
}
