import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { shopDayEnd, shopDayStart } from "@/lib/format";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { issueOfflinePass } from "@/server/auth/offline-pass";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { NotFoundError } from "@/server/errors";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize, can } from "@/server/permissions";
import { type CheckoutCatalogue, getCheckoutCatalogue } from "./sales";

/**
 * Selling without internet, for the business in use (C60, C61): what the checkout computer
 * keeps so that it can carry on during an outage, and the report of what was out of the
 * ordinary about sales made that way. The sales themselves are saved by `postOfflineSale`
 * and a till opened offline by `openTillOffline`.
 */

export type OfflineKit = {
  /** Signed by the server: who this is and until when they may sell without internet. */
  pass: string;
  passExpiresAt: Date;
  cashier: { userId: string; name: string };
  /** What is printed around a receipt. */
  business: { id: string; name: string; receiptHeader: string | null; receiptFooter: string | null; taxNumber: string | null };
  /** Products, prices, payment methods and customers, as the checkout shows them. */
  catalogue: CheckoutCatalogue;
  /** Each terminal's paper width and the next number of its offline receipt series, as far as the server knows. */
  terminals: { id: string; code: string; paperWidth: "MM58" | "MM80"; nextOfflineNumber: number }[];
  takenAt: Date;
};

/**
 * Everything the checkout computer needs to keep selling if the internet drops: handed over
 * whenever the checkout is opened online, and kept on that computer.
 */
export async function getOfflineKit(context: AppContext): Promise<OfflineKit> {
  authorize(context, "sale.create");
  const db = businessDb(context);
  const [catalogue, business, terminals] = await Promise.all([
    getCheckoutCatalogue(context),
    db.business.findFirst({ select: { id: true, name: true, receiptHeader: true, receiptFooter: true, taxNumber: true } }),
    db.terminal.findMany({ where: { deactivatedAt: null }, orderBy: { code: "asc" }, select: { id: true, code: true, paperWidth: true, nextOfflineNumber: true } }),
  ]);
  if (!business) throw new NotFoundError("That business could not be found.");
  const now = new Date();
  const pass = issueOfflinePass(context, now);
  return {
    pass: pass.token,
    passExpiresAt: pass.expiresAt,
    cashier: { userId: context.actor.userId, name: context.actor.name },
    business,
    catalogue,
    terminals,
    takenAt: now,
  };
}

// ---------------------------------------------------------------------------
// The offline exceptions report
// ---------------------------------------------------------------------------

const KINDS = ["STOCK_SHORT", "PRICE_DIFFERENT", "OUT_OF_USE", "TIME", "ACCOUNT", "RECEIPT_NUMBER"] as const;
export type OfflineExceptionKindValue = (typeof KINDS)[number];

const listSchema = z.object({
  kind: z.string().trim().optional().default(""),
  /** "open" for those nobody has looked at yet, "done" for the rest; empty for all. */
  status: z.enum(["", "open", "done"]).optional().default(""),
  from: z.string().trim().optional().default(""),
  to: z.string().trim().optional().default(""),
  page: pageNumber,
});

export type OfflineExceptionRow = {
  id: string;
  kind: OfflineExceptionKindValue;
  summary: string;
  foundAt: Date;
  sale: { id: string; receiptNumber: string; cashierName: string; soldAt: Date; cancelled: boolean };
  /** Set once someone has looked at it. */
  review: { reviewedByName: string; note: string | null; at: Date } | null;
};

/** What was out of the ordinary about sales made offline, newest first. */
export async function listOfflineExceptions(
  context: AppContext,
  input: unknown = {},
): Promise<{ rows: OfflineExceptionRow[]; waiting: number; canReview: boolean } & Paged> {
  authorize(context, "report.sales.view");
  const { kind, status, from, to, page } = parseInput(listSchema, input);
  const start = shopDayStart(from);
  const end = shopDayEnd(to);
  const where: Prisma.OfflineExceptionWhereInput = {
    ...((KINDS as readonly string[]).includes(kind) ? { kind: kind as OfflineExceptionKindValue } : {}),
    ...(status === "open" ? { review: null } : {}),
    ...(status === "done" ? { review: { isNot: null } } : {}),
    ...(start || end ? { createdAt: { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) } } : {}),
  };
  const db = businessDb(context);
  const [total, waiting, rows] = await Promise.all([
    db.offlineException.count({ where }),
    db.offlineException.count({ where: { review: null } }),
    db.offlineException.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        review: true,
        sale: { select: { id: true, receiptNumber: true, cashierName: true, deviceTime: true, createdAt: true, cancellation: { select: { id: true } } } },
      },
    }),
  ]);
  return {
    waiting,
    canReview: can(context, "sale.cancel"),
    rows: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      summary: row.summary,
      foundAt: row.createdAt,
      sale: {
        id: row.sale.id,
        receiptNumber: row.sale.receiptNumber,
        cashierName: row.sale.cashierName,
        soldAt: row.sale.deviceTime ?? row.sale.createdAt,
        cancelled: !!row.sale.cancellation,
      },
      review: row.review ? { reviewedByName: row.review.reviewedByName, note: row.review.note, at: row.review.createdAt } : null,
    })),
    ...paged(total, page),
  };
}

const reviewSchema = z.object({
  exceptionId: z.string().uuid("That entry could not be found."),
  note: z.string().trim().max(300, "The note is too long (300 characters at most).").optional().default(""),
});

/**
 * A manager or admin marks an offline exception as looked at, with an optional note on what
 * was done about it. Nothing else changes: putting the stock right is done with a count and
 * an adjustment. Marking it twice changes nothing.
 */
export async function reviewOfflineException(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "sale.cancel");
  const data = parseInput(reviewSchema, input);
  const db = businessDb(context);
  const exception = await db.offlineException.findFirst({
    where: { id: data.exceptionId },
    select: { id: true, summary: true, review: { select: { id: true } }, sale: { select: { receiptNumber: true } } },
  });
  if (!exception) throw new NotFoundError("That entry could not be found.");
  if (exception.review) return;
  try {
    await db.$transaction(async (tx) => {
      await tx.offlineExceptionReview.create({
        data: {
          businessId: businessIdOf(context),
          exceptionId: exception.id,
          note: data.note || null,
          reviewedByUserId: context.actor.userId,
          reviewedByName: context.actor.name,
        },
      });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "offline_exception.reviewed",
          summary: `${context.actor.name} looked at an offline exception on sale ${exception.sale.receiptNumber}${data.note ? `: ${data.note}` : "."}`,
          targetType: "offline_exception",
          targetId: exception.id,
        }),
      });
    });
  } catch (error) {
    // Marked by someone else at the same instant: that stands.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }
}
