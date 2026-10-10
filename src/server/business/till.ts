import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { breakdownTotal, type CashBreakdown, describeBreakdown, NAIRA_NOTES, storeBreakdown } from "@/lib/cash-notes";
import { Decimal } from "@/lib/decimal";
import { formatDateTime, shopDayEnd, shopDayStart, shopToday, tillSessionNumber } from "@/lib/format";
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
import { cashierOfPass } from "@/server/offline-cashier";
import { drawerMovements } from "@/server/till-cash";
import { authorize, can } from "@/server/permissions";

/**
 * Till sessions for the business in use.
 *
 * A till session is one stretch of selling at one checkout terminal — one cash drawer —
 * from opening it with a float to closing it with a count. A terminal has at most one open
 * session, and a sale can only be made at a terminal whose till is open (see postSale).
 *
 * Expected cash = the opening float + every CASH payment taken in the session + every CASH
 * repayment of a customer's debt received in it − every CASH refund paid out of it for a
 * cancelled sale. (A payment's amount is what the sale was owed,
 * so change given is already left out.)
 *
 * The count is "blind" (SPEC C51): the person who runs the till is never shown the expected
 * cash, the cash taken, or whether their count balanced — not even after closing. Those who
 * may review any till (admin, manager, accountant) see all of it at any time.
 *
 * An admin or manager may recount a closed till on the same business day (C52); each recount
 * is a record of its own. Sessions, closings and recounts are add-only.
 */

const MAX_MONEY = new Decimal("99999999999.99");

type Db = ReturnType<typeof businessDb>;

/** Those who may review any till see every session; others only the ones they opened. */
function ownOnly(context: AppContext): Prisma.TillSessionWhereInput {
  return can(context, "till.reviewAny") ? {} : { openedByUserId: context.actor.userId };
}

/**
 * Cash that went into the drawer in a session — from sales and from customers repaying
 * debts — less cash refunded out of it (cancelled sales).
 */
async function cashTakenIn(db: Parameters<typeof drawerMovements>[0], sessionId: string): Promise<Decimal> {
  return (await drawerMovements(db, sessionId)).net;
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
    /** Cash in / cash out asked for in this session (C64): all for reviewers, a person's own otherwise. */
    cashRequests: TillCashRequestView[];
    /** True when what this person records counts at once, without waiting for approval. */
    cashCountsAtOnce: boolean;
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
      cashRequests: await cashRequestsOf(context, db, session.id),
      cashCountsAtOnce: answersCashRequests(context),
      expectedCash: reviews ? moneyToString(new Decimal(session.openingFloat.toFixed(2)).plus(await cashTakenIn(db, session.id))) : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Cash in and cash out during the day (C64)
// ---------------------------------------------------------------------------

export type TillCashRequestView = {
  id: string;
  direction: "IN" | "OUT";
  amount: string;
  note: string;
  requestedByName: string;
  requestedAt: Date;
  /** WAITING until someone allowed to has answered. */
  status: "WAITING" | "APPROVED" | "REFUSED" | "WITHDRAWN";
  decidedByName: string | null;
  decisionNote: string | null;
  /** True when this person may still take it back. */
  canWithdraw: boolean;
};

/** Whoever may both review tills and run one answers cash requests: admin, manager, owner (not the accountant). */
const answersCashRequests = (context: AppContext) => can(context, "till.reviewAny") && can(context, "till.operateOwn");

async function cashRequestsOf(context: AppContext, db: Db, sessionId: string): Promise<TillCashRequestView[]> {
  const rows = await db.tillCashRequest.findMany({
    where: { tillSessionId: sessionId, ...(can(context, "till.reviewAny") ? {} : { requestedByUserId: context.actor.userId }) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: { decision: true },
  });
  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    amount: row.amount.toFixed(2),
    note: row.note,
    requestedByName: row.requestedByName,
    requestedAt: row.createdAt,
    status: row.decision?.outcome ?? "WAITING",
    decidedByName: row.decision?.decidedByName ?? null,
    decisionNote: row.decision?.note ?? null,
    canWithdraw: !row.decision && row.requestedByUserId === context.actor.userId,
  }));
}

const cashRequestSchema = z.object({
  /** Made up on the person's computer, so pressing the button twice saves one request. */
  requestId: z.string().uuid("This form has expired. Reload the page."),
  sessionId: z.string().uuid("That till session could not be found."),
  direction: z.enum(["IN", "OUT"], "Choose cash in or cash out."),
  amount: z.string().trim(),
  note: z.string().trim().min(3, "Say what the cash is for.").max(300, "The note is too long (300 characters at most)."),
});

const NOT_RECORDED = "Nothing was recorded. Please correct what is marked.";

/** What the drawer of an open session should hold right now. Call with the terminal's turn taken. */
async function shouldHold(tx: Parameters<typeof drawerMovements>[0] & Pick<Db, "tillSession">, sessionId: string): Promise<Decimal> {
  const session = await tx.tillSession.findFirst({ where: { id: sessionId }, select: { openingFloat: true } });
  return new Decimal(session?.openingFloat.toFixed(2) ?? "0").plus((await drawerMovements(tx, sessionId)).net);
}

/**
 * Asks to put cash into an open till, or take cash out of it, with a note saying why. From
 * someone who may answer such requests it counts at once; from anyone else it waits for one
 * of them. Sending the same request again changes nothing.
 */
export async function requestTillCash(context: AppContext, input: unknown): Promise<{ id: string; status: "WAITING" | "APPROVED" }> {
  authorize(context, "till.operateOwn");
  const businessId = businessIdOf(context);
  const data = parseInput(cashRequestSchema, input);
  const db = businessDb(context);

  const fieldErrors: Record<string, string> = {};
  const amount = parseAmount(data.amount, fieldErrors, "amount", "Enter the amount as a plain number greater than zero, for example 5000 (no commas).");
  if (amount && !amount.greaterThan(0)) fieldErrors.amount = "Enter an amount greater than zero.";
  if (!amount || Object.keys(fieldErrors).length > 0) throw new ValidationError(NOT_RECORDED, fieldErrors);

  const saved = async () => {
    const row = await db.tillCashRequest.findFirst({ where: { requestId: data.requestId }, select: { id: true, decision: { select: { outcome: true } } } });
    return row ? { id: row.id, status: row.decision?.outcome === "APPROVED" ? ("APPROVED" as const) : ("WAITING" as const) } : null;
  };
  const repeat = await saved();
  if (repeat) return repeat;

  const session = await db.tillSession.findFirst({
    where: { id: data.sessionId },
    select: { id: true, number: true, terminalId: true, terminalCode: true, close: { select: { id: true } } },
  });
  if (!session) throw new NotFoundError("That till session could not be found.");
  const atOnce = answersCashRequests(context);
  const words = data.direction === "IN" ? "put into" : "taken out of";

  try {
    return await db.$transaction(
      async (tx) => {
        // The terminal's "turn", as for selling and closing: the till cannot be closed underneath this.
        await tx.terminal.update({ where: { id: session.terminalId }, data: { updatedAt: new Date() }, select: { id: true } });
        const closed = await tx.tillSessionClose.findFirst({ where: { sessionId: session.id }, select: { id: true } });
        if (closed) throw new ValidationError(`Nothing was recorded: ${tillSessionNumber(session.number)} is closed.`);
        if (atOnce && data.direction === "OUT") {
          const holds = await shouldHold(tx, session.id);
          if (holds.lessThan(amount)) {
            throw new ValidationError(NOT_RECORDED, { amount: `The till of ${session.terminalCode} should only hold ${formatNaira(holds)}.` });
          }
        }
        const request = await tx.tillCashRequest.create({
          data: {
            businessId,
            requestId: data.requestId,
            tillSessionId: session.id,
            direction: data.direction,
            amount: moneyToString(amount),
            note: data.note,
            requestedByUserId: context.actor.userId,
            requestedByName: context.actor.name,
          },
          select: { id: true },
        });
        if (atOnce) {
          await tx.tillCashDecision.create({
            data: { businessId, cashRequestId: request.id, outcome: "APPROVED", decidedByUserId: context.actor.userId, decidedByName: context.actor.name },
          });
        }
        await tx.activityLog.create({
          data: activityRow(context, {
            action: atOnce ? "till.cash_recorded" : "till.cash_requested",
            summary: atOnce
              ? `${context.actor.name} recorded ${formatNaira(amount)} ${words} the till of ${session.terminalCode} (${tillSessionNumber(session.number)}): ${data.note}`
              : `${context.actor.name} asked for ${formatNaira(amount)} to be ${words} the till of ${session.terminalCode} (${tillSessionNumber(session.number)}): ${data.note}`,
            targetType: "till_cash_request",
            targetId: request.id,
          }),
        });
        return { id: request.id, status: atOnce ? ("APPROVED" as const) : ("WAITING" as const) };
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const again = await saved();
      if (again) return again;
    }
    throw error;
  }
}

export type WaitingTillCash = {
  id: string;
  direction: "IN" | "OUT";
  amount: string;
  note: string;
  requestedByName: string;
  requestedAt: Date;
  terminalCode: string;
  sessionNumber: number;
};

/** The cash requests of open tills that are waiting for an answer, oldest first. */
export async function listWaitingTillCash(context: AppContext): Promise<{ requests: WaitingTillCash[] }> {
  authorize(context, "till.reviewAny");
  authorize(context, "till.operateOwn");
  const rows = await businessDb(context).tillCashRequest.findMany({
    where: { decision: null, tillSession: { close: null } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 50,
    include: { tillSession: { select: { number: true, terminalCode: true } } },
  });
  return {
    requests: rows.map((row) => ({
      id: row.id,
      direction: row.direction,
      amount: row.amount.toFixed(2),
      note: row.note,
      requestedByName: row.requestedByName,
      requestedAt: row.createdAt,
      terminalCode: row.tillSession.terminalCode,
      sessionNumber: row.tillSession.number,
    })),
  };
}

const decideCashSchema = z.object({
  cashRequestId: z.string().uuid("That request could not be found."),
  approve: z.boolean(),
  note: z.string().trim().max(300, "The note is too long (300 characters at most).").optional().default(""),
});

const CASH_ALREADY_ANSWERED = "That request has already been answered or taken back.";

/**
 * A manager, admin or owner approves or refuses a cash request. Once approved it is part of
 * what the till should hold. Cash out is refused if the till should not hold that much.
 */
export async function decideTillCash(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "till.reviewAny");
  authorize(context, "till.operateOwn");
  const businessId = businessIdOf(context);
  const data = parseInput(decideCashSchema, input);
  const db = businessDb(context);
  const request = await db.tillCashRequest.findFirst({
    where: { id: data.cashRequestId },
    include: { decision: { select: { id: true } }, tillSession: { select: { id: true, number: true, terminalId: true, terminalCode: true } } },
  });
  if (!request) throw new NotFoundError("That request could not be found.");
  if (request.decision) throw new ValidationError(CASH_ALREADY_ANSWERED);
  const amount = new Decimal(request.amount.toFixed(2));
  const session = request.tillSession;

  try {
    await db.$transaction(
      async (tx) => {
        await tx.terminal.update({ where: { id: session.terminalId }, data: { updatedAt: new Date() }, select: { id: true } });
        // The answer first: there can be only one.
        await tx.tillCashDecision.create({
          data: {
            businessId,
            cashRequestId: request.id,
            outcome: data.approve ? "APPROVED" : "REFUSED",
            note: data.note || null,
            decidedByUserId: context.actor.userId,
            decidedByName: context.actor.name,
          },
        });
        if (data.approve) {
          const closed = await tx.tillSessionClose.findFirst({ where: { sessionId: session.id }, select: { id: true } });
          if (closed) throw new ValidationError(`${tillSessionNumber(session.number)} has been closed, so this can no longer be approved. It can only be refused.`);
          // Checked with this request already counted: the drawer may not go below zero.
          if (request.direction === "OUT" && (await shouldHold(tx, session.id)).isNegative()) {
            const holds = (await shouldHold(tx, session.id)).plus(amount);
            throw new ValidationError(`Not approved: the till of ${session.terminalCode} should only hold ${formatNaira(holds)}, less than the ${formatNaira(amount)} asked for.`);
          }
        }
        await tx.activityLog.create({
          data: activityRow(context, {
            action: data.approve ? "till.cash_approved" : "till.cash_refused",
            summary:
              `${context.actor.name} ${data.approve ? "approved" : "refused"} ${formatNaira(amount)} ${request.direction === "IN" ? "into" : "out of"} the till of ` +
              `${session.terminalCode} (${tillSessionNumber(session.number)}), asked for by ${request.requestedByName}: ${request.note}${data.note ? ` — ${data.note}` : ""}`,
            targetType: "till_cash_request",
            targetId: request.id,
          }),
        });
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ValidationError(CASH_ALREADY_ANSWERED);
    throw error;
  }
}

/** The person who asked takes a waiting cash request back. Nothing happens if it was already answered. */
export async function withdrawTillCash(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "till.operateOwn");
  const { cashRequestId } = parseInput(z.object({ cashRequestId: z.string().uuid("That request could not be found.") }), input);
  const db = businessDb(context);
  const request = await db.tillCashRequest.findFirst({
    where: { id: cashRequestId, requestedByUserId: context.actor.userId },
    select: { id: true, decision: { select: { id: true } } },
  });
  if (!request) throw new NotFoundError("That request could not be found.");
  if (request.decision) return;
  try {
    await db.tillCashDecision.create({
      data: { businessId: businessIdOf(context), cashRequestId: request.id, outcome: "WITHDRAWN", decidedByUserId: context.actor.userId, decidedByName: context.actor.name },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }
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

/** How the cash was counted, note by note — sent only when the person used "Count by notes". */
const breakdownSchema = z
  .object({
    notes: z.partialRecord(z.enum(NAIRA_NOTES), z.string().trim().max(8)),
    other: z.string().trim().max(15).optional().default(""),
  })
  .optional();

/**
 * Checks a note-by-note count against the amount it is meant to explain and returns it in
 * the form it is stored in. A breakdown that does not add up to the amount is refused, not
 * dropped: it would mean the screen and what is being saved disagree.
 */
function checkedBreakdown(
  breakdown: z.infer<typeof breakdownSchema>,
  amount: Decimal | null,
  fieldErrors: Record<string, string>,
): string | null {
  if (!breakdown || !amount) return null;
  const counted: CashBreakdown = { notes: breakdown.notes, other: breakdown.other };
  const total = breakdownTotal(counted);
  if (!total) {
    fieldErrors.breakdown = "Check the numbers under \"Count by notes\": each must be a whole number of notes.";
    return null;
  }
  if (!total.equals(amount)) {
    fieldErrors.breakdown = `The notes add up to ${formatNaira(total)}, but the amount typed is ${formatNaira(amount)}. Count again, or correct the amount.`;
    return null;
  }
  return storeBreakdown(counted);
}

const openSchema = z.object({
  terminalId: z.string().uuid("Choose the checkout terminal."),
  openingFloat: z.string().trim(),
  breakdown: breakdownSchema,
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
  const floatBreakdown = checkedBreakdown(data.breakdown, float, fieldErrors);
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
          floatBreakdown,
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

const openOfflineSchema = openSchema.extend({
  /** The pass the server signed for the person while they were online. */
  pass: z.string().min(1).max(2000),
  deviceTime: z.string().datetime(),
});

/**
 * A till that was opened on the checkout computer during an internet outage is opened here
 * when the internet returns, before that computer's waiting sales are sent (C60). It is
 * recorded under the person named in the signed offline pass, whoever sends it.
 *
 * If the terminal's till is already open — it was opened before the outage, or this was
 * already sent — nothing changes and that till is given back: the waiting sales go into it.
 */
export async function openTillOffline(context: AppContext, input: unknown): Promise<{ id: string; number: number; alreadyOpen: boolean }> {
  authorize(context, "sale.create");
  const { pass, deviceTime, ...data } = parseInput(openOfflineSchema, input);
  const { asCashier } = await cashierOfPass(context, pass);
  const db = businessDb(context);
  const open = () => db.tillSession.findFirst({ where: { terminalId: data.terminalId, close: null }, select: { id: true, number: true } });

  const already = await open();
  if (already) return { ...already, alreadyOpen: true };
  try {
    const opened = await openTill(asCashier, data);
    await db.activityLog.create({
      data: activityRow(asCashier, {
        action: "till.opened_offline",
        summary:
          `${tillSessionNumber(opened.number)} was opened by ${asCashier.actor.name} without internet, at ${formatDateTime(new Date(deviceTime))} ` +
          `by the checkout computer's clock, and sent to the server${context.actor.userId === asCashier.actor.userId ? "" : ` by ${context.actor.name}`} now.`,
        targetType: "till_session",
        targetId: opened.id,
      }),
    });
    return { ...opened, alreadyOpen: false };
  } catch (error) {
    // Someone opened it at the same instant: the waiting sales go into that one.
    const now = error instanceof ValidationError ? await open() : null;
    if (now) return { ...now, alreadyOpen: true };
    throw error;
  }
}

const closeSchema = z.object({
  sessionId: z.string().uuid("That till session could not be found."),
  countedCash: z.string().trim(),
  breakdown: breakdownSchema,
  note: optionalText(300, "The note is too long (300 characters at most).").optional().default(""),
});

export type CloseResult = {
  id: string;
  number: number;
  countedCash: string;
  /** Only for those who may review any till. The person who ran the till is not told the result. */
  expectedCash: string | null;
  difference: string | null;
  alreadyClosed: boolean;
};

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
  const reviews = can(context, "till.reviewAny");
  const closed = (close: NonNullable<typeof session.close>): CloseResult => ({
    id: session.id,
    number: session.number,
    countedCash: close.countedCash.toFixed(2),
    expectedCash: reviews ? close.expectedCash.toFixed(2) : null,
    difference: reviews ? close.difference.toFixed(2) : null,
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
  const breakdown = checkedBreakdown(data.breakdown, counted, fieldErrors);
  if (!counted || Object.keys(fieldErrors).length > 0) {
    throw new ValidationError("The till was not closed. Please correct the highlighted field.", fieldErrors);
  }

  try {
    return await db.$transaction(
      async (tx) => {
        // The terminal's "turn": no sale can be going through this till while it is being closed.
        await tx.terminal.update({ where: { id: session.terminalId }, data: { updatedAt: new Date() }, select: { id: true } });
        // A cash request still waiting would change what the drawer should hold: it must be answered first.
        const unanswered = await tx.tillCashRequest.count({ where: { tillSessionId: session.id, decision: null } });
        if (unanswered > 0) {
          throw new ValidationError(
            `The till was not closed: ${unanswered === 1 ? "a cash in / cash out request is" : `${unanswered} cash in / cash out requests are`} still waiting for a manager. ` +
              "Ask for an answer, or take the request back, then close the till.",
          );
        }
        const expected = new Decimal(session.openingFloat.toFixed(2)).plus(await cashTakenIn(tx, session.id));
        const difference = counted.minus(expected);
        await tx.tillSessionClose.create({
          data: {
            businessId,
            sessionId: session.id,
            expectedCash: moneyToString(expected),
            countedCash: moneyToString(counted),
            difference: moneyToString(difference),
            breakdown,
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
          countedCash: moneyToString(counted),
          expectedCash: reviews ? moneyToString(expected) : null,
          difference: reviews ? moneyToString(difference) : null,
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

const recountSchema = z.object({
  sessionId: z.string().uuid("That till session could not be found."),
  countedCash: z.string().trim(),
  breakdown: breakdownSchema,
  note: z.string().trim().min(5, "Say why the till was counted again.").max(300, "The note is too long (300 characters at most)."),
});

export type RecountResult = { id: string; expectedCash: string; countedCash: string; difference: string };

/**
 * Records a manager's or admin's own count of a till that has been closed, on the same
 * business day it was closed. It is a record of its own: the closing count stays as it was.
 * A till can be recounted more than once.
 */
export async function recountTill(context: AppContext, input: unknown): Promise<RecountResult> {
  // Those who both review tills and run them: admins, managers and owners. Not the accountant, not a cashier.
  authorize(context, "till.reviewAny");
  authorize(context, "till.operateOwn");
  const businessId = businessIdOf(context);
  const data = parseInput(recountSchema, input);
  const db = businessDb(context);

  const session = await db.tillSession.findFirst({ where: { id: data.sessionId }, include: { close: true } });
  if (!session) throw new NotFoundError("That till session could not be found.");
  if (!session.close) throw new ValidationError("This till is still open. It is counted when it is closed.");
  if (shopToday(session.close.createdAt) !== shopToday()) {
    throw new ValidationError("A till can only be recounted on the day it was closed.");
  }

  const fieldErrors: Record<string, string> = {};
  const counted = parseAmount(
    data.countedCash,
    fieldErrors,
    "countedCash",
    "Enter the cash you counted as a plain amount, for example 48500 (0 if there is none).",
  );
  const breakdown = checkedBreakdown(data.breakdown, counted, fieldErrors);
  if (!counted || Object.keys(fieldErrors).length > 0) {
    throw new ValidationError("The recount was not saved. Please correct the highlighted field.", fieldErrors);
  }

  const expected = new Decimal(session.close.expectedCash.toFixed(2));
  const difference = counted.minus(expected);
  return db.$transaction(async (tx) => {
    const recount = await tx.tillSessionRecount.create({
      data: {
        businessId,
        sessionId: session.id,
        expectedCash: moneyToString(expected),
        countedCash: moneyToString(counted),
        difference: moneyToString(difference),
        breakdown,
        note: data.note,
        recountedByUserId: context.actor.userId,
        recountedByName: context.actor.name,
      },
    });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "till.recounted",
        summary:
          `${context.actor.name} recounted the till of ${session.terminalCode} (${tillSessionNumber(session.number)}): ` +
          `counted ${formatNaira(counted)}, expected ${formatNaira(expected)}` +
          (difference.isZero() ? " — it balanced." : ` — ${formatNaira(difference.abs())} ${difference.isNegative() ? "SHORT" : "OVER"}.`) +
          ` The closing count was ${formatNaira(new Decimal(session.close!.countedCash.toFixed(2)))}. Note: ${data.note}`,
        targetType: "till_session",
        targetId: session.id,
        details: { number: session.number, expected: moneyToString(expected), counted: moneyToString(counted), difference: moneyToString(difference) },
      }),
    });
    return { id: recount.id, expectedCash: moneyToString(expected), countedCash: moneyToString(counted), difference: moneyToString(difference) };
  });
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
  /**
   * Counted minus expected, once closed (by the latest count: a recount if there is one):
   * negative means short. Only for those who may review any till.
   */
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
      include: { close: true, recounts: { orderBy: { createdAt: "desc" }, take: 1 } },
    }),
  ]);
  const reviews = can(context, "till.reviewAny");
  return {
    ownOnly: !reviews,
    canOperate: can(context, "till.operateOwn"),
    sessions: rows.map((row) => ({
      id: row.id,
      number: row.number,
      terminalCode: row.terminalCode,
      openedByName: row.openedByName,
      openedAt: row.openedAt,
      closedAt: row.close?.createdAt ?? null,
      closedByName: row.close?.closedByName ?? null,
      difference: reviews ? ((row.recounts[0] ?? row.close)?.difference.toFixed(2) ?? null) : null,
    })),
    ...paged(total, page),
  };
}

export type TillSessionDetail = TillSessionSummary & {
  terminalId: string;
  openingFloat: string;
  saleCount: number;
  salesTotal: string;
  /** Sales made in this session that were later cancelled (they are left out of the count and total above). */
  cancelledCount: number;
  /** What was taken, by payment method, largest first. */
  byMethod: { methodName: string; kind: PaymentKindValue; count: number; amount: string }[];
  /** Cash paid back out of this till for cancelled sales. Only for those who may review any till. */
  cashRefunded: string | null;
  /** Cash received in this till from customers repaying debts. Only for those who may review any till. */
  cashRepaid: string | null;
  /** Cash put into and taken out of the drawer during the day, once approved (C64). Only for reviewers. */
  cashPutIn: string | null;
  cashTakenOut: string | null;
  /** The cash-in / cash-out requests of this session: all of them for reviewers, a person's own otherwise. */
  cashRequests: TillCashRequestView[];
  /** Float + cash taken; once closed, the figure stored at closing. Only for those who may review any till. */
  expectedCash: string | null;
  /** What was counted at closing. Shown to the person who closed it too. */
  countedCash: string | null;
  /** The closing count against the expected cash. Only for those who may review any till. */
  closingDifference: string | null;
  closingNote: string | null;
  /**
   * How the float and the closing cash were counted, note by note ("60 × ₦1,000", …), when
   * "Count by notes" was used. Only for those who may review any till.
   */
  floatBreakdown: string[];
  closingBreakdown: string[];
  /** Counts made again after closing, oldest first. Only for those who may review any till. */
  recounts: { id: string; countedCash: string; difference: string; breakdown: string[]; note: string; recountedByName: string; createdAt: Date }[];
  /** True when this person may close it now. */
  canClose: boolean;
  /** True when this person may recount it now: closed today, and they both review and run tills. */
  canRecount: boolean;
};

export async function getTillSession(context: AppContext, input: unknown): Promise<TillSessionDetail> {
  if (!can(context, "till.reviewAny")) authorize(context, "till.operateOwn");
  const { sessionId } = parseInput(z.object({ sessionId: z.string().uuid("That till session could not be found.") }), input);
  const db = businessDb(context);

  const session = await db.tillSession.findFirst({
    where: { id: sessionId, ...ownOnly(context) },
    include: { close: true, recounts: { orderBy: { createdAt: "asc" } } },
  });
  if (!session) throw new NotFoundError("That till session could not be found.");

  const [sales, cancelledCount, cashRefunds, cashRepayments, groups] = await Promise.all([
    db.sale.aggregate({ where: { tillSessionId: session.id, cancellation: null }, _count: { _all: true }, _sum: { total: true } }),
    db.sale.count({ where: { tillSessionId: session.id, cancellation: { isNot: null } } }),
    db.refund.aggregate({ where: { tillSessionId: session.id, kind: "CASH" }, _sum: { amount: true } }),
    db.repayment.aggregate({ where: { tillSessionId: session.id, kind: "CASH" }, _sum: { amount: true } }),
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
  const cashRefunded = new Decimal(cashRefunds._sum.amount?.toFixed(2) ?? "0");
  const cashRepaid = new Decimal(cashRepayments._sum.amount?.toFixed(2) ?? "0");
  const drawer = await drawerMovements(db, session.id);
  const cash = drawer.net;
  const reviews = can(context, "till.reviewAny");
  const cashRequests = await cashRequestsOf(context, db, session.id);

  return {
    id: session.id,
    number: session.number,
    terminalCode: session.terminalCode,
    openedByName: session.openedByName,
    openedAt: session.openedAt,
    closedAt: session.close?.createdAt ?? null,
    closedByName: session.close?.closedByName ?? null,
    difference: reviews ? ((session.recounts.at(-1) ?? session.close)?.difference.toFixed(2) ?? null) : null,
    terminalId: session.terminalId,
    openingFloat: session.openingFloat.toFixed(2),
    saleCount: sales._count._all,
    salesTotal: sales._sum.total?.toFixed(2) ?? "0.00",
    cancelledCount,
    cashRefunded: reviews ? moneyToString(cashRefunded) : null,
    cashRepaid: reviews ? moneyToString(cashRepaid) : null,
    cashPutIn: reviews ? moneyToString(drawer.cashIn) : null,
    cashTakenOut: reviews ? moneyToString(drawer.cashOut) : null,
    cashRequests,
    // What was taken in cash would give the expected figure away, so only reviewers see it.
    byMethod: byMethod.filter((entry) => reviews || entry.kind !== "CASH").map((entry) => ({ ...entry, amount: moneyToString(entry.amount) })),
    expectedCash: !reviews
      ? null
      : session.close
        ? session.close.expectedCash.toFixed(2)
        : moneyToString(new Decimal(session.openingFloat.toFixed(2)).plus(cash)),
    countedCash: session.close?.countedCash.toFixed(2) ?? null,
    closingDifference: reviews ? (session.close?.difference.toFixed(2) ?? null) : null,
    closingNote: session.close?.note ?? null,
    floatBreakdown: reviews ? describeBreakdown(session.floatBreakdown) : [],
    closingBreakdown: reviews ? describeBreakdown(session.close?.breakdown ?? null) : [],
    recounts: reviews
      ? session.recounts.map((recount) => ({
          id: recount.id,
          countedCash: recount.countedCash.toFixed(2),
          difference: recount.difference.toFixed(2),
          breakdown: describeBreakdown(recount.breakdown),
          note: recount.note,
          recountedByName: recount.recountedByName,
          createdAt: recount.createdAt,
        }))
      : [],
    canRecount:
      reviews && can(context, "till.operateOwn") && session.close !== null && shopToday(session.close.createdAt) === shopToday(),
    canClose: session.close === null && can(context, "till.operateOwn") && (reviews || session.openedByUserId === context.actor.userId),
  };
}
