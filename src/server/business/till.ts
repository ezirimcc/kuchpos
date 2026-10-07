import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { shopDayEnd, shopDayStart, tillSessionNumber } from "@/lib/format";
import { formatNaira, moneyToString, parseMoney } from "@/lib/money";
import type { PaymentKindValue } from "@/lib/payment-kinds";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { takeDocumentNumber } from "@/server/document-number";
import { NotFoundError, ValidationError } from "@/server/errors";
import { optionalText } from "@/server/input";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize, can } from "@/server/permissions";

/**
 * Till sessions for the business in use.
 *
 * A till session is one stretch of selling at one checkout terminal — one cash drawer —
 * from opening it with a float to closing it with a count. A terminal has at most one open
 * session, and a sale can only be made at a terminal whose till is open (see postSale).
 *
 * Expected cash = the opening float + every CASH payment taken in the session. (A payment's
 * amount is what the sale was owed, so change given is already left out.)
 *
 * The count is "blind": the person who runs the till is not shown the expected cash until
 * the session is closed. Those who may review any till (admin, manager, accountant) see it
 * at any time. Sessions and their closings are add-only.
 */

const MAX_MONEY = new Decimal("99999999999.99");
const ZERO = new Decimal(0);

type Db = ReturnType<typeof businessDb>;

/** Those who may review any till see every session; others only the ones they opened. */
function ownOnly(context: AppContext): Prisma.TillSessionWhereInput {
  return can(context, "till.reviewAny") ? {} : { openedByUserId: context.actor.userId };
}

async function cashTakenIn(db: Pick<Db, "payment">, sessionId: string): Promise<Decimal> {
  const sum = await db.payment.aggregate({ where: { tillSessionId: sessionId, kind: "CASH" }, _sum: { amount: true } });
  return new Decimal(sum._sum.amount?.toFixed(2) ?? "0");
}

// ---------------------------------------------------------------------------
// The till of one terminal, as the person at it sees it
// ---------------------------------------------------------------------------

export type TillNow = {
  terminals: { id: string; code: string; name: string }[];
  /** The open session of the terminal asked about, if it has one. */
  open: {
    id: string;
    number: number;
    terminalCode: string;
    openingFloat: string;
    openedByName: string;
    openedAt: Date;
    saleCount: number;
    /** True when this person may close it: they opened it, or they may review any till. */
    canClose: boolean;
    /** Only for those who may review any till: the cash that should be in the drawer now. */
    expectedCash: string | null;
  } | null;
};

const terminalSchema = z.object({ terminalId: z.string().trim().optional().default("") });

export async function getTill(context: AppContext, input: unknown = {}): Promise<TillNow> {
  authorize(context, "till.operateOwn");
  const { terminalId } = parseInput(terminalSchema, input);
  const db = businessDb(context);

  const terminals = await db.terminal.findMany({
    where: { deactivatedAt: null },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });
  const terminal = terminals.find((candidate) => candidate.id === terminalId);
  if (!terminal) return { terminals, open: null };

  const session = await db.tillSession.findFirst({
    where: { terminalId: terminal.id, close: null },
    include: { _count: { select: { sales: true } } },
  });
  if (!session) return { terminals, open: null };

  const reviews = can(context, "till.reviewAny");
  return {
    terminals,
    open: {
      id: session.id,
      number: session.number,
      terminalCode: session.terminalCode,
      openingFloat: session.openingFloat.toFixed(2),
      openedByName: session.openedByName,
      openedAt: session.openedAt,
      saleCount: session._count.sales,
      canClose: reviews || session.openedByUserId === context.actor.userId,
      expectedCash: reviews ? moneyToString(new Decimal(session.openingFloat.toFixed(2)).plus(await cashTakenIn(db, session.id))) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------

function parseAmount(text: string, fieldErrors: Record<string, string>, field: string, message: string): Decimal | null {
  try {
    const amount = parseMoney(text);
    if (amount.isNegative() || amount.greaterThan(MAX_MONEY)) throw new Error("out of range");
    return amount;
  } catch {
    fieldErrors[field] = message;
    return null;
  }
}

const openSchema = z.object({
  terminalId: z.string().uuid("Choose the checkout terminal."),
  openingFloat: z.string().trim(),
});

/**
 * Opens the till of a terminal with the cash put in the drawer for change (0 is allowed).
 * Refused if that terminal's till is already open.
 */
export async function openTill(context: AppContext, input: unknown): Promise<{ id: string; number: number }> {
  authorize(context, "till.operateOwn");
  const businessId = businessIdOf(context);
  const data = parseInput(openSchema, input);
  const db = businessDb(context);

  const fieldErrors: Record<string, string> = {};
  const float = parseAmount(
    data.openingFloat,
    fieldErrors,
    "openingFloat",
    "Enter the cash in the drawer as a plain amount, for example 5000 (0 if there is none).",
  );
  const terminal = await db.terminal.findFirst({ where: { id: data.terminalId }, select: { id: true, code: true, deactivatedAt: true } });
  if (!terminal) fieldErrors.terminalId = "Choose the checkout terminal.";
  else if (terminal.deactivatedAt) fieldErrors.terminalId = "This checkout terminal is out of use.";
  if (!terminal || !float || Object.keys(fieldErrors).length > 0) {
    throw new ValidationError("The till was not opened. Please correct the highlighted fields.", fieldErrors);
  }

  return db.$transaction(
    async (tx) => {
      // The terminal's "turn": opening, closing and selling at one terminal happen one at a time.
      await tx.terminal.update({ where: { id: terminal.id }, data: { updatedAt: new Date() }, select: { id: true } });
      const already = await tx.tillSession.findFirst({
        where: { terminalId: terminal.id, close: null },
        select: { number: true, openedByName: true },
      });
      if (already) {
        throw new ValidationError(
          `The till of ${terminal.code} is already open (${tillSessionNumber(already.number)}, opened by ${already.openedByName}). ` +
            "It must be closed before it can be opened again.",
        );
      }
      const number = await takeDocumentNumber(tx, businessId, "TILL_SESSION");
      const session = await tx.tillSession.create({
        data: {
          businessId,
          number,
          terminalId: terminal.id,
          terminalCode: terminal.code,
          openingFloat: moneyToString(float),
          openedByUserId: context.actor.userId,
          openedByName: context.actor.name,
        },
      });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "till.opened",
          summary: `${context.actor.name} opened the till of ${terminal.code} (${tillSessionNumber(number)}) with a float of ${formatNaira(float)}.`,
          targetType: "till_session",
          targetId: session.id,
          details: { number, terminal: terminal.code, openingFloat: moneyToString(float) },
        }),
      });
      return { id: session.id, number };
    },
    { isolationLevel: "ReadCommitted", timeout: 20_000 },
  );
}

const closeSchema = z.object({
  sessionId: z.string().uuid("That till session could not be found."),
  countedCash: z.string().trim(),
  note: optionalText(300, "The note is too long (300 characters at most).").optional().default(""),
});

export type CloseResult = { id: string; number: number; expectedCash: string; countedCash: string; difference: string; alreadyClosed: boolean };

/**
 * Closes a till session with the cash counted in the drawer. The expected cash is worked
 * out at this moment, inside the same transaction, and stored with the count.
 * Only the person who opened the session, or someone who may review any till, can close it.
 */
export async function closeTill(context: AppContext, input: unknown): Promise<CloseResult> {
  authorize(context, "till.operateOwn");
  const businessId = businessIdOf(context);
  const data = parseInput(closeSchema, input);
  const db = businessDb(context);

  const session = await db.tillSession.findFirst({ where: { id: data.sessionId, ...ownOnly(context) }, include: { close: true } });
  if (!session) throw new NotFoundError("That till session could not be found.");
  const closed = (close: NonNullable<typeof session.close>): CloseResult => ({
    id: session.id,
    number: session.number,
    expectedCash: close.expectedCash.toFixed(2),
    countedCash: close.countedCash.toFixed(2),
    difference: close.difference.toFixed(2),
    alreadyClosed: true,
  });
  if (session.close) return closed(session.close);

  const fieldErrors: Record<string, string> = {};
  const counted = parseAmount(
    data.countedCash,
    fieldErrors,
    "countedCash",
    "Enter the cash you counted in the drawer as a plain amount, for example 48500 (0 if there is none).",
  );
  if (!counted) throw new ValidationError("The till was not closed. Please correct the highlighted field.", fieldErrors);

  try {
    return await db.$transaction(
      async (tx) => {
        // The terminal's "turn": no sale can be going through this till while it is being closed.
        await tx.terminal.update({ where: { id: session.terminalId }, data: { updatedAt: new Date() }, select: { id: true } });
        const expected = new Decimal(session.openingFloat.toFixed(2)).plus(await cashTakenIn(tx, session.id));
        const difference = counted.minus(expected);
        await tx.tillSessionClose.create({
          data: {
            businessId,
            sessionId: session.id,
            expectedCash: moneyToString(expected),
            countedCash: moneyToString(counted),
            difference: moneyToString(difference),
            note: data.note || null,
            closedByUserId: context.actor.userId,
            closedByName: context.actor.name,
          },
        });
        await tx.activityLog.create({
          data: activityRow(context, {
            action: "till.closed",
            summary:
              `${context.actor.name} closed the till of ${session.terminalCode} (${tillSessionNumber(session.number)}): ` +
              `counted ${formatNaira(counted)}, expected ${formatNaira(expected)}` +
              (difference.isZero() ? " — it balanced." : ` — ${formatNaira(difference.abs())} ${difference.isNegative() ? "SHORT" : "OVER"}.`) +
              (data.note ? ` Note: ${data.note}` : ""),
            targetType: "till_session",
            targetId: session.id,
            details: { number: session.number, expected: moneyToString(expected), counted: moneyToString(counted), difference: moneyToString(difference) },
          }),
        });
        return {
          id: session.id,
          number: session.number,
          expectedCash: moneyToString(expected),
          countedCash: moneyToString(counted),
          difference: moneyToString(difference),
          alreadyClosed: false,
        };
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );
  } catch (error) {
    // Someone else closed it at the same moment: report their closing.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const now = await db.tillSessionClose.findFirst({ where: { sessionId: session.id } });
      if (now) return closed(now);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Sessions: list and detail
// ---------------------------------------------------------------------------

export type TillSessionSummary = {
  id: string;
  number: number;
  terminalCode: string;
  openedByName: string;
  openedAt: Date;
  closedAt: Date | null;
  closedByName: string | null;
  /** Counted minus expected, once closed: negative means short. */
  difference: string | null;
};

const dayFilter = z
  .string()
  .trim()
  .optional()
  .default("")
  .transform((value) => (shopDayStart(value) ? value : ""));

const listSchema = z.object({
  status: z
    .string()
    .optional()
    .default("")
    .transform((value) => (["open", "closed"].includes(value) ? value : "")),
  from: dayFilter,
  to: dayFilter,
  page: pageNumber,
});

/** One page of till sessions, newest first. Without the right to review any till, only the person's own. */
export async function listTillSessions(
  context: AppContext,
  input: unknown = {},
): Promise<{ sessions: TillSessionSummary[]; ownOnly: boolean; canOperate: boolean } & Paged> {
  if (!can(context, "till.reviewAny")) authorize(context, "till.operateOwn");
  const { status, from, to, page } = parseInput(listSchema, input);

  const openedAt: Prisma.DateTimeFilter = {};
  if (from) openedAt.gte = shopDayStart(from)!;
  if (to) openedAt.lte = shopDayEnd(to)!;
  const where: Prisma.TillSessionWhereInput = {
    ...ownOnly(context),
    ...(from || to ? { openedAt } : {}),
    ...(status === "open" ? { close: null } : {}),
    ...(status === "closed" ? { close: { isNot: null } } : {}),
  };
  const db = businessDb(context);
  const [total, rows] = await Promise.all([
    db.tillSession.count({ where }),
    db.tillSession.findMany({
      where,
      orderBy: [{ number: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { close: true },
    }),
  ]);
  return {
    ownOnly: !can(context, "till.reviewAny"),
    canOperate: can(context, "till.operateOwn"),
    sessions: rows.map((row) => ({
      id: row.id,
      number: row.number,
      terminalCode: row.terminalCode,
      openedByName: row.openedByName,
      openedAt: row.openedAt,
      closedAt: row.close?.createdAt ?? null,
      closedByName: row.close?.closedByName ?? null,
      difference: row.close?.difference.toFixed(2) ?? null,
    })),
    ...paged(total, page),
  };
}

export type TillSessionDetail = TillSessionSummary & {
  terminalId: string;
  openingFloat: string;
  saleCount: number;
  salesTotal: string;
  /** What was taken, by payment method, largest first. */
  byMethod: { methodName: string; kind: PaymentKindValue; count: number; amount: string }[];
  /**
   * Float + cash taken. For an open session only those who may review any till are told
   * (the count is blind); once closed it is the figure stored at closing.
   */
  expectedCash: string | null;
  countedCash: string | null;
  closingNote: string | null;
  /** True when this person may close it now. */
  canClose: boolean;
};

export async function getTillSession(context: AppContext, input: unknown): Promise<TillSessionDetail> {
  if (!can(context, "till.reviewAny")) authorize(context, "till.operateOwn");
  const { sessionId } = parseInput(z.object({ sessionId: z.string().uuid("That till session could not be found.") }), input);
  const db = businessDb(context);

  const session = await db.tillSession.findFirst({ where: { id: sessionId, ...ownOnly(context) }, include: { close: true } });
  if (!session) throw new NotFoundError("That till session could not be found.");

  const [sales, groups] = await Promise.all([
    db.sale.aggregate({ where: { tillSessionId: session.id }, _count: { _all: true }, _sum: { total: true } }),
    db.payment.groupBy({
      by: ["methodName", "kind"],
      where: { tillSessionId: session.id },
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);
  const byMethod = groups
    .map((group) => ({
      methodName: group.methodName,
      kind: group.kind,
      count: group._count._all,
      amount: new Decimal(group._sum.amount?.toFixed(2) ?? "0"),
    }))
    .sort((a, b) => b.amount.comparedTo(a.amount) || a.methodName.localeCompare(b.methodName));
  const cash = byMethod.filter((entry) => entry.kind === "CASH").reduce((sum, entry) => sum.plus(entry.amount), ZERO);
  const reviews = can(context, "till.reviewAny");

  return {
    id: session.id,
    number: session.number,
    terminalCode: session.terminalCode,
    openedByName: session.openedByName,
    openedAt: session.openedAt,
    closedAt: session.close?.createdAt ?? null,
    closedByName: session.close?.closedByName ?? null,
    difference: session.close?.difference.toFixed(2) ?? null,
    terminalId: session.terminalId,
    openingFloat: session.openingFloat.toFixed(2),
    saleCount: sales._count._all,
    salesTotal: sales._sum.total?.toFixed(2) ?? "0.00",
    // While the till is open, what was taken in cash would give the expected figure away.
    byMethod: byMethod
      .filter((entry) => session.close !== null || reviews || entry.kind !== "CASH")
      .map((entry) => ({ ...entry, amount: moneyToString(entry.amount) })),
    expectedCash: session.close
      ? session.close.expectedCash.toFixed(2)
      : reviews
        ? moneyToString(new Decimal(session.openingFloat.toFixed(2)).plus(cash))
        : null,
    countedCash: session.close?.countedCash.toFixed(2) ?? null,
    closingNote: session.close?.note ?? null,
    canClose: session.close === null && can(context, "till.operateOwn") && (reviews || session.openedByUserId === context.actor.userId),
  };
}
