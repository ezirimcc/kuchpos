import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb } from "@/server/db/scoped";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize } from "@/server/permissions";
import type { ActivityItem } from "@/server/platform/owners";
import { shopDayEnd, shopDayStart } from "@/lib/format";

const dayText = z
  .string()
  .trim()
  .optional()
  .default("")
  .transform((value) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ""));

const listSchema = z.object({
  /** Words to look for in what happened or in the person's name. */
  search: z.string().trim().max(120).optional().default(""),
  /** First and last day to show, as YYYY-MM-DD in the shop's own time. */
  from: dayText,
  to: dayText,
  page: pageNumber,
});

/** One page of the activity log of the business in use, newest first. */
export async function listActivity(
  context: AppContext,
  input: unknown = {},
): Promise<{ entries: ActivityItem[] } & Paged> {
  authorize(context, "activityLog.view");
  const { search, from, to, page } = parseInput(listSchema, input);

  const createdAt: Prisma.DateTimeFilter = {};
  const start = from ? shopDayStart(from) : null;
  const end = to ? shopDayEnd(to) : null;
  if (start) createdAt.gte = start;
  if (end) createdAt.lt = end;

  const where: Prisma.ActivityLogWhereInput = {
    ...(start || end ? { createdAt } : {}),
    ...(search ? { OR: [{ summary: { contains: search } }, { actorName: { contains: search } }] } : {}),
  };
  const db = businessDb(context);
  const [total, entries] = await Promise.all([
    db.activityLog.count({ where }),
    db.activityLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, createdAt: true, actorName: true, actorRole: true, action: true, summary: true },
    }),
  ]);
  return { entries, ...paged(total, page) };
}
