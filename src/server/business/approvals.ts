import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { shopDayEnd, shopDayStart } from "@/lib/format";
import { formatNaira, moneyToString, parseMoney, sumMoney } from "@/lib/money";
import { verifyApprover } from "@/server/auth/approver";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { activityRow } from "@/server/activity";
import { NotFoundError, ValidationError } from "@/server/errors";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize, can, ROLE_LABELS } from "@/server/permissions";
import { APPROVAL_MINUTES, checkDiscount, checkSaleLines, creditFingerprint, discountFingerprint, saleLinesSchema } from "@/server/sale-lines";

/**
 * Approvals at the checkout, for the business in use.
 *
 * A cashier who wants to give an extra discount, or to let a customer go over their credit
 * limit, asks a manager, admin or owner to type their own username and password on the
 * cashier's screen. That writes an approval for exactly this sale and exactly this
 * discount (or credit). `postSale` spends it — once — when the sale is saved; it runs out
 * after ten minutes. Approvals are add-only.
 */

/** Wrong guesses allowed in the time an approval lasts, before more are refused. */
const MAX_REFUSALS = 5;

const NOT_APPROVED = "Not approved. Please correct what is marked.";

const askSchema = z.object({
  kind: z.enum(["DISCOUNT", "CREDIT_OVER_LIMIT"]),
  /** The ID the checkout gave the sale. The approval is good for that sale only. */
  saleRequestId: z.string().uuid("This sale has expired. Start a new sale."),
  lines: saleLinesSchema,
  discount: z
    .object({
      amount: z.string().trim(),
      percent: z.string().trim().optional().default(""),
      reason: z.string().trim().min(3, "Say why the discount is being given.").max(300, "The reason is too long (300 characters at most)."),
    })
    .optional(),
  customerId: z.string().trim().optional().default(""),
  creditAmount: z.string().trim().optional().default(""),
});

const approveSchema = askSchema.extend({
  /** The approver's own sign-in details, typed by them. Used once here and kept nowhere. */
  username: z.string().trim().min(1, "The approver enters their username.").max(100),
  password: z.string().min(1, "The approver enters their password.").max(200),
});

/** What an approver is shown about the sale, kept with a request as it was when asked. */
export type ApprovalDetails = {
  lines: { productName: string; quantity: string; unitName: string; unitPrice: string; lineTotal: string }[];
  subtotal: string;
  discountPercent: string | null;
  customer: { name: string; owes: string; creditLimit: string } | null;
};

type Asked = {
  permission: "discount.approve" | "customer.setCreditLimit";
  fingerprint: string;
  amount: Decimal;
  basis: Decimal;
  reason: string | null;
  summary: string;
  details: ApprovalDetails;
};

/**
 * Works out, from the server's own prices, exactly what is being asked for — and checks that
 * the person asking may ask. Shared by approving at the screen and by sending a request.
 */
async function workOutWhatIsAsked(context: AppContext, data: z.infer<typeof askSchema>): Promise<Asked> {
  const db = businessDb(context);
  const fieldErrors: Record<string, string> = {};
  const { checked } = await checkSaleLines(db, context, data.lines, fieldErrors);
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError("The sale itself has a problem. Correct what is marked before asking for approval.", fieldErrors);
  }
  const subtotal = sumMoney(checked.map((line) => line.lineTotal));
  const lines = checked.map((line) => ({
    productName: line.productName,
    quantity: line.quantity,
    unitName: line.unitName,
    unitPrice: moneyToString(line.unitPrice),
    lineTotal: moneyToString(line.lineTotal),
  }));

  if (data.kind === "DISCOUNT") {
    authorize(context, "discount.request");
    if (!data.discount) throw new ValidationError(NOT_APPROVED, { "discount.amount": "Enter the discount first." });
    const { discount, percent } = checkDiscount(subtotal, data.discount, fieldErrors);
    if (Object.keys(fieldErrors).length > 0) throw new ValidationError(NOT_APPROVED, fieldErrors);
    return {
      permission: "discount.approve",
      fingerprint: discountFingerprint(data.saleRequestId, checked, discount),
      amount: discount,
      basis: subtotal,
      reason: data.discount.reason,
      summary: `a discount of ${formatNaira(discount)} on a sale of ${formatNaira(subtotal)}`,
      details: { lines, subtotal: moneyToString(subtotal), discountPercent: percent ? percent.toFixed(2) : null, customer: null },
    };
  }

  authorize(context, "sale.credit");
  const customer = data.customerId
    ? await db.customer.findFirst({
        where: { id: data.customerId, deactivatedAt: null },
        select: { id: true, name: true, balance: true, creditLimit: true },
      })
    : null;
  if (!customer) throw new ValidationError(NOT_APPROVED, { creditAmount: "Choose the customer first." });
  if (customer.creditLimit === null) {
    throw new ValidationError(NOT_APPROVED, {
      creditAmount: `${customer.name} cannot buy on credit yet. An admin or manager must first give them a credit limit.`,
    });
  }
  let credit: Decimal;
  try {
    credit = parseMoney(data.creditAmount);
    if (!credit.greaterThan(0) || credit.greaterThan(subtotal)) throw new Error("out of range");
  } catch {
    throw new ValidationError(NOT_APPROVED, { creditAmount: "Enter the amount on credit as a plain number, no more than the total." });
  }
  const owes = new Decimal(customer.balance.toFixed(2));
  const limit = new Decimal(customer.creditLimit.toFixed(2));
  const owedAfter = owes.plus(credit);
  return {
    permission: "customer.setCreditLimit",
    fingerprint: creditFingerprint(data.saleRequestId, customer.id, credit),
    amount: credit,
    basis: owedAfter,
    reason: null,
    summary: `${formatNaira(credit)} on credit for ${customer.name}, who would then owe ${formatNaira(owedAfter)} against a limit of ${formatNaira(limit)}`,
    details: {
      lines,
      subtotal: moneyToString(subtotal),
      discountPercent: null,
      customer: { name: customer.name, owes: moneyToString(owes), creditLimit: moneyToString(limit) },
    },
  };
}

export type ApprovalGiven = {
  approvalId: string;
  approvedByName: string;
  /** When it runs out if the sale is not completed. */
  expiresAt: Date;
};

/**
 * A manager, admin or owner approves a discount — or credit over a customer's limit — at
 * the cashier's screen. The sale is worked out here again from the server's own prices, so
 * what is approved is what will be checked when the sale is saved.
 */
export async function approveAtScreen(context: AppContext, input: unknown): Promise<ApprovalGiven> {
  authorize(context, "sale.create");
  const data = parseInput(approveSchema, input);
  const db = businessDb(context);
  const businessId = businessIdOf(context);
  const what = await workOutWhatIsAsked(context, data);
  const permission = what.permission;

  // A few wrong guesses and no more are taken for a while — from this person, or against that username.
  const username = data.username.toLowerCase();
  const since = new Date(Date.now() - APPROVAL_MINUTES * 60_000);
  const refusals = await db.activityLog.count({
    where: {
      action: "approval.refused",
      createdAt: { gt: since },
      OR: [{ actorUserId: context.actor.userId }, { targetType: "approver", targetId: username }],
    },
  });
  if (refusals >= MAX_REFUSALS) {
    throw new ValidationError(NOT_APPROVED, {
      password: `Too many wrong tries. Wait ${APPROVAL_MINUTES} minutes, then ask the manager to try again.`,
    });
  }

  const approver = await verifyApprover({ username, password: data.password, businessId, permission });
  if (!approver) {
    await db.activityLog.create({
      data: {
        businessId,
        actorUserId: context.actor.userId,
        actorName: context.actor.name,
        actorRole: context.actor.role,
        action: "approval.refused",
        summary: `An approval of ${what.summary} was tried with the username "${username.slice(0, 40)}" and refused.`,
        targetType: "approver",
        targetId: username,
      },
    });
    throw new ValidationError(NOT_APPROVED, {
      password: "That username and password were not accepted, or that person is not allowed to approve this.",
    });
  }

  const expiresAt = new Date(Date.now() + APPROVAL_MINUTES * 60_000);
  const approval = await db.$transaction(async (tx) => {
    const created = await tx.approval.create({
      data: {
        businessId,
        kind: data.kind,
        method: "AT_SCREEN",
        saleRequestId: data.saleRequestId,
        fingerprint: what.fingerprint,
        amount: moneyToString(what.amount),
        basis: moneyToString(what.basis),
        reason: what.reason,
        requestedByUserId: context.actor.userId,
        requestedByName: context.actor.name,
        approvedByUserId: approver.userId,
        approvedByName: approver.name,
        expiresAt,
      },
      select: { id: true },
    });
    // Written under the approver's own name: it is their decision.
    await tx.activityLog.create({
      data: {
        businessId,
        actorUserId: approver.userId,
        actorName: approver.name,
        actorRole: approver.role,
        action: "approval.given",
        summary:
          `${approver.name} (${ROLE_LABELS[approver.role]}) approved ${what.summary}, asked for by ${context.actor.name}` +
          `${what.reason ? `. Reason: ${what.reason}` : ""}.`,
        targetType: "approval",
        targetId: created.id,
      },
    });
    return created;
  });
  return { approvalId: approval.id, approvedByName: approver.name, expiresAt };
}

// ---------------------------------------------------------------------------
// The discounts and approvals report
// ---------------------------------------------------------------------------

const listSchema = z.object({
  search: z.string().trim().max(100).optional().default(""),
  kind: z.enum(["", "DISCOUNT", "CREDIT_OVER_LIMIT"]).optional().default(""),
  from: z.string().trim().optional().default(""),
  to: z.string().trim().optional().default(""),
  page: pageNumber,
});

export type ApprovalRow = {
  id: string;
  kind: "DISCOUNT" | "CREDIT_OVER_LIMIT";
  /** True when the seller approved it themselves, as someone allowed to. */
  ownSale: boolean;
  /** True when it was approved from the approver's own computer, not at the cashier's screen. */
  remote: boolean;
  /** The discount, or the amount put on credit. */
  amount: string;
  /** The sale before the discount, or what the customer would owe afterwards. */
  basis: string;
  reason: string | null;
  requestedByName: string;
  approvedByName: string;
  approvedAt: Date;
  /** The sale it was used on; null when it was never used. */
  sale: { id: string; receiptNumber: string; cancelled: boolean } | null;
  /** True when it was never used and has run out. */
  expired: boolean;
};

/** Every approval given, newest first, with the total of the discounts actually given in the period. */
export async function listApprovals(
  context: AppContext,
  input: unknown = {},
): Promise<{ rows: ApprovalRow[]; discountTotal: string; discountCount: number; canOpenSales: boolean } & Paged> {
  authorize(context, "report.discounts.view");
  const { search, kind, from, to, page } = parseInput(listSchema, input);

  const createdAt: Prisma.DateTimeFilter = {};
  if (from && shopDayStart(from)) createdAt.gte = shopDayStart(from)!;
  if (to && shopDayEnd(to)) createdAt.lte = shopDayEnd(to)!;
  const where: Prisma.ApprovalWhereInput = {
    ...(createdAt.gte || createdAt.lte ? { createdAt } : {}),
    ...(kind ? { kind } : {}),
    ...(search
      ? {
          OR: [
            { requestedByName: { contains: search } },
            { approvedByName: { contains: search } },
            { reason: { contains: search } },
            { use: { sale: { receiptNumber: { contains: search } } } },
          ],
        }
      : {}),
  };
  const db = businessDb(context);
  const [total, rows, given] = await Promise.all([
    db.approval.count({ where }),
    db.approval.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { use: { select: { sale: { select: { id: true, receiptNumber: true, cancellation: { select: { id: true } } } } } } },
    }),
    // Discounts that really reached a sale which still stands.
    db.approval.aggregate({
      where: { ...where, kind: "DISCOUNT", use: { sale: { cancellation: null } } },
      _sum: { amount: true },
      _count: true,
    }),
  ]);
  const now = Date.now();
  return {
    canOpenSales: can(context, "report.sales.view"),
    discountTotal: (given._sum.amount ?? new Decimal(0)).toFixed(2),
    discountCount: given._count,
    rows: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      ownSale: row.method === "OWN_SALE",
      remote: row.method === "REMOTE",
      amount: row.amount.toFixed(2),
      basis: row.basis.toFixed(2),
      reason: row.reason,
      requestedByName: row.requestedByName,
      approvedByName: row.approvedByName,
      approvedAt: row.createdAt,
      sale: row.use
        ? { id: row.use.sale.id, receiptNumber: row.use.sale.receiptNumber, cancelled: !!row.use.sale.cancellation }
        : null,
      expired: !row.use && row.expiresAt.getTime() <= now,
    })),
    ...paged(total, page),
  };
}

// ---------------------------------------------------------------------------
// Approval from the manager's own computer (C57)
// ---------------------------------------------------------------------------

const ALREADY_ANSWERED = "That request has already been answered or taken back.";

/**
 * The cashier sends a discount — or credit over a customer's limit — to be approved by
 * someone at another computer. Asking again for exactly the same thing while the first
 * request is still waiting gives that request back.
 */
export async function requestApproval(context: AppContext, input: unknown): Promise<{ requestId: string; expiresAt: Date }> {
  authorize(context, "sale.create");
  const data = parseInput(askSchema, input);
  const what = await workOutWhatIsAsked(context, data);
  const db = businessDb(context);
  const businessId = businessIdOf(context);

  const waiting = await db.approvalRequest.findFirst({
    where: {
      kind: data.kind,
      saleRequestId: data.saleRequestId,
      fingerprint: what.fingerprint,
      requestedByUserId: context.actor.userId,
      decision: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, expiresAt: true },
  });
  if (waiting) return { requestId: waiting.id, expiresAt: waiting.expiresAt };

  const expiresAt = new Date(Date.now() + APPROVAL_MINUTES * 60_000);
  const created = await db.approvalRequest.create({
    data: {
      businessId,
      kind: data.kind,
      saleRequestId: data.saleRequestId,
      fingerprint: what.fingerprint,
      amount: moneyToString(what.amount),
      basis: moneyToString(what.basis),
      reason: what.reason,
      details: JSON.stringify(what.details),
      requestedByUserId: context.actor.userId,
      requestedByName: context.actor.name,
      expiresAt,
    },
    select: { id: true },
  });
  return { requestId: created.id, expiresAt };
}

const requestIdSchema = z.object({ requestId: z.string().uuid("That request could not be found.") });

export type ApprovalRequestStatus =
  | { status: "WAITING"; expiresAt: Date }
  | { status: "APPROVED"; approvalId: string; approvedByName: string }
  | { status: "REFUSED"; refusedByName: string; note: string | null }
  | { status: "WITHDRAWN" }
  | { status: "EXPIRED" };

/** What has become of a request. Only the person who sent it may ask. */
export async function getApprovalRequest(context: AppContext, input: unknown): Promise<ApprovalRequestStatus> {
  authorize(context, "sale.create");
  const { requestId } = parseInput(requestIdSchema, input);
  const request = await businessDb(context).approvalRequest.findFirst({
    where: { id: requestId, requestedByUserId: context.actor.userId },
    select: { expiresAt: true, decision: { select: { outcome: true, note: true, decidedByName: true } }, approval: { select: { id: true, approvedByName: true } } },
  });
  if (!request) throw new NotFoundError("That request could not be found.");
  if (request.decision?.outcome === "APPROVED" && request.approval) {
    return { status: "APPROVED", approvalId: request.approval.id, approvedByName: request.approval.approvedByName };
  }
  if (request.decision?.outcome === "REFUSED") {
    return { status: "REFUSED", refusedByName: request.decision.decidedByName, note: request.decision.note };
  }
  if (request.decision) return { status: "WITHDRAWN" };
  if (request.expiresAt.getTime() <= Date.now()) return { status: "EXPIRED" };
  return { status: "WAITING", expiresAt: request.expiresAt };
}

/** The person who sent a request takes it back. Nothing happens if it was already answered. */
export async function withdrawApprovalRequest(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "sale.create");
  const { requestId } = parseInput(requestIdSchema, input);
  const db = businessDb(context);
  const request = await db.approvalRequest.findFirst({
    where: { id: requestId, requestedByUserId: context.actor.userId },
    select: { id: true, decision: { select: { id: true } } },
  });
  if (!request) throw new NotFoundError("That request could not be found.");
  if (request.decision) return;
  try {
    await db.approvalRequestDecision.create({
      data: {
        businessId: businessIdOf(context),
        requestId: request.id,
        outcome: "WITHDRAWN",
        decidedByUserId: context.actor.userId,
        decidedByName: context.actor.name,
      },
    });
  } catch (error) {
    // Answered at the same instant: the answer stands.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }
}

/** The kinds of request this person may answer. */
function kindsAnswerable(context: AppContext): ("DISCOUNT" | "CREDIT_OVER_LIMIT")[] {
  return [
    ...(can(context, "discount.approve") ? (["DISCOUNT"] as const) : []),
    ...(can(context, "customer.setCreditLimit") ? (["CREDIT_OVER_LIMIT"] as const) : []),
  ];
}

export type WaitingApproval = {
  id: string;
  kind: "DISCOUNT" | "CREDIT_OVER_LIMIT";
  amount: string;
  basis: string;
  reason: string | null;
  details: ApprovalDetails;
  requestedByName: string;
  requestedAt: Date;
  expiresAt: Date;
};

/** The requests waiting for an answer that this person may give, oldest first. */
export async function listWaitingApprovals(context: AppContext): Promise<{ requests: WaitingApproval[] }> {
  if (!can(context, "customer.setCreditLimit")) authorize(context, "discount.approve");
  const rows = await businessDb(context).approvalRequest.findMany({
    where: { kind: { in: kindsAnswerable(context) }, decision: null, expiresAt: { gt: new Date() } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 50,
  });
  return {
    requests: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      amount: row.amount.toFixed(2),
      basis: row.basis.toFixed(2),
      reason: row.reason,
      details: JSON.parse(row.details) as ApprovalDetails,
      requestedByName: row.requestedByName,
      requestedAt: row.createdAt,
      expiresAt: row.expiresAt,
    })),
  };
}

const decideSchema = z.object({
  requestId: z.string().uuid("That request could not be found."),
  approve: z.boolean(),
  note: z.string().trim().max(300, "The note is too long (300 characters at most).").optional().default(""),
});

/**
 * A manager, admin or owner answers a waiting request from their own computer. Approving
 * writes the approval the cashier's sale will spend; refusing writes only the answer.
 */
export async function decideApprovalRequest(context: AppContext, input: unknown): Promise<void> {
  if (!can(context, "customer.setCreditLimit")) authorize(context, "discount.approve");
  const data = parseInput(decideSchema, input);
  const db = businessDb(context);
  const businessId = businessIdOf(context);

  const request = await db.approvalRequest.findFirst({ where: { id: data.requestId }, include: { decision: { select: { id: true } } } });
  if (!request) throw new NotFoundError("That request could not be found.");
  authorize(context, request.kind === "DISCOUNT" ? "discount.approve" : "customer.setCreditLimit");
  if (request.decision) throw new ValidationError(ALREADY_ANSWERED);
  if (request.expiresAt.getTime() <= Date.now()) {
    throw new ValidationError(`That request has run out: it waits ${APPROVAL_MINUTES} minutes. The cashier can send it again.`);
  }

  const amount = new Decimal(request.amount.toFixed(2));
  const basis = new Decimal(request.basis.toFixed(2));
  const what =
    request.kind === "DISCOUNT"
      ? `a discount of ${formatNaira(amount)} on a sale of ${formatNaira(basis)}`
      : `${formatNaira(amount)} on credit over a customer's limit (owing ${formatNaira(basis)} afterwards)`;
  try {
    await db.$transaction(async (tx) => {
      // The answer first: there can be only one, so a second answerer stops here.
      await tx.approvalRequestDecision.create({
        data: {
          businessId,
          requestId: request.id,
          outcome: data.approve ? "APPROVED" : "REFUSED",
          note: data.note || null,
          decidedByUserId: context.actor.userId,
          decidedByName: context.actor.name,
        },
      });
      let approvalId: string | null = null;
      if (data.approve) {
        const approval = await tx.approval.create({
          data: {
            businessId,
            kind: request.kind,
            method: "REMOTE",
            saleRequestId: request.saleRequestId,
            fingerprint: request.fingerprint,
            amount: request.amount,
            basis: request.basis,
            reason: request.reason,
            requestedByUserId: request.requestedByUserId,
            requestedByName: request.requestedByName,
            approvedByUserId: context.actor.userId,
            approvedByName: context.actor.name,
            expiresAt: new Date(Date.now() + APPROVAL_MINUTES * 60_000),
            requestId: request.id,
          },
          select: { id: true },
        });
        approvalId = approval.id;
      }
      await tx.activityLog.create({
        data: activityRow(context, {
          action: data.approve ? "approval.given" : "approval.turned_down",
          summary:
            `${context.actor.name} (${ROLE_LABELS[context.actor.role]}) ${data.approve ? "approved" : "refused"} ${what}, asked for by ${request.requestedByName}` +
            `${request.reason ? `. Reason: ${request.reason}` : ""}${data.note ? `. Note: ${data.note}` : ""}.`,
          targetType: data.approve ? "approval" : "approval_request",
          targetId: approvalId ?? request.id,
        }),
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ValidationError(ALREADY_ANSWERED);
    throw error;
  }
}
