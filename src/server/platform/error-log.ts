import "server-only";
import type { AppContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize } from "@/server/permissions";

/**
 * The app's own error log (C68), for owners only. It is about the whole system, not one
 * business, which is why it lives here beside the System check. Written by `recordError`
 * (`src/server/db/error-record.ts`) from every place that catches an unexpected failure.
 */

const KEEP_DAYS = 90;

export type ErrorLogRow = {
  id: string;
  at: Date;
  kind: string;
  place: string;
  message: string;
  detail: string | null;
  digest: string | null;
  businessName: string | null;
  userName: string | null;
  appVersion: string | null;
};

/** What went wrong, newest first. Entries older than 90 days are cleared as the list is read. */
export async function listErrors(context: AppContext, input: { page?: string } = {}): Promise<{ rows: ErrorLogRow[]; last24Hours: number } & Paged> {
  authorize(context, "owner.manage");
  const db = getDb();
  await db.errorLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000) } } });

  const page = pageNumber.parse(input.page);
  const [total, last24Hours, rows] = await Promise.all([
    db.errorLog.count(),
    db.errorLog.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
    db.errorLog.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
  ]);
  // Names only, one line per business: no business's records are read here.
  const businessIds = [...new Set(rows.map((row) => row.businessId).filter((id): id is string => id !== null))];
  const businesses = businessIds.length > 0 ? await db.business.findMany({ where: { id: { in: businessIds } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(businesses.map((business) => [business.id, business.name]));
  return {
    rows: rows.map((row) => ({
      id: row.id,
      at: row.createdAt,
      kind: row.kind,
      place: row.place,
      message: row.message,
      detail: row.detail,
      digest: row.digest,
      businessName: row.businessId ? (nameOf.get(row.businessId) ?? null) : null,
      userName: row.userName,
      appVersion: row.appVersion,
    })),
    last24Hours,
    ...paged(total, page),
  };
}
