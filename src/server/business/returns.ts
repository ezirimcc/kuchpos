import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { returnNumber, shopDayEnd, shopDayStart, shopToday } from "@/lib/format";
import { formatNaira, moneyToString, movingAverageCost, sumMoney } from "@/lib/money";
import type { PaymentKindValue } from "@/lib/payment-kinds";
import { quantityToString } from "@/lib/quantity";
import { activityRow } from "@/server/activity";
import { claimApproval } from "@/server/approval-claim";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { takeDocumentNumber } from "@/server/document-number";
import { NotFoundError, ValidationError } from "@/server/errors";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize, can } from "@/server/permissions";
import { type Disposition, returnableLines, type ReturnableLine, returnSchema, workOutReturn } from "@/server/return-lines";
import { APPROVAL_MINUTES } from "@/server/sale-lines";
import { drawerMovements } from "@/server/till-cash";

/**
 * Returns of goods, for the business in use (C62). A return always refers to a sale, never
 * changes it, and is saved whole or not at all: the goods back into stock (or written off),
 * the customer's debt on that sale reduced, the rest of the refund handed back, the approval
 * spent. Returns are add-only.
 */

const NOT_RETURNED = "Nothing was returned. Please correct what is marked.";
const MAX_ATTEMPTS = 3;

type Db = ReturnType<typeof businessDb>;
type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

/** What the customer still owes on one credit sale: what went on credit, less repayments, less earlier returns. */
async function owedOnSale(db: Pick<Tx, "repaymentAllocation" | "saleReturn">, sale: { id: string; creditAmount: Decimal }): Promise<Decimal> {
  if (!sale.creditAmount.greaterThan(0)) return new Decimal(0);
  const [repaid, returned] = await Promise.all([
    db.repaymentAllocation.aggregate({ where: { saleId: sale.id }, _sum: { amount: true } }),
    db.saleReturn.aggregate({ where: { saleId: sale.id }, _sum: { debtReduced: true } }),
  ]);
  return Decimal.max(sale.creditAmount.minus(repaid._sum.amount?.toFixed(2) ?? "0").minus(returned._sum.debtReduced?.toFixed(2) ?? "0"), 0);
}

export type ReturnOptions = {
  sale: { id: string; receiptNumber: string; soldAt: Date; cashierName: string; customerName: string | null; terminalId: string };
  lines: ReturnableLine[];
  /** Why nothing can be returned from this sale, if that is so. */
  blocked: string | null;
  /** What the customer still owes on this sale: a refund comes off this first. */
  owedOnSale: string;
  paymentMethods: { id: string; name: string; kind: PaymentKindValue }[];
  /** Checkouts whose till is open: a cash refund comes out of one of them. */
  openTills: { terminalId: string; code: string; name: string }[];
  hasStoreroom: boolean;
  /** True when this person needs a manager, admin or owner to approve the return. */
  needsApproval: boolean;
  earlier: { id: string; number: number; refundTotal: string; createdAt: Date; createdByName: string }[];
};

const optionsSchema = z.object({
  saleId: z.string().trim().optional().default(""),
  /** Or the number on the customer's receipt. */
  receiptNumber: z.string().trim().max(20).optional().default(""),
});

/** A sale and what may still come back from it. Found by its id or by the number on the receipt. */
export async function getReturnOptions(context: AppContext, input: unknown): Promise<ReturnOptions> {
  authorize(context, "return.request");
  const { saleId, receiptNumber } = parseInput(optionsSchema, input);
  const db = businessDb(context);
  const found = /^[0-9a-f-]{36}$/i.test(saleId)
    ? saleId
    : receiptNumber
      ? (await db.sale.findFirst({ where: { receiptNumber }, select: { id: true } }))?.id
      : undefined;
  if (!found) throw new NotFoundError("No sale has that receipt number. Check the number on the customer's receipt.");

  const { sale, lines, lastDay } = await returnableLines(db, found);
  const [owed, paymentMethods, tills, locations, earlier] = await Promise.all([
    owedOnSale(db, sale),
    db.paymentMethod.findMany({ where: { deactivatedAt: null }, orderBy: [{ builtIn: "desc" }, { name: "asc" }], select: { id: true, name: true, kind: true } }),
    db.tillSession.findMany({ where: { close: null }, select: { terminal: { select: { id: true, code: true, name: true } } } }),
    db.location.findMany({ select: { kind: true } }),
    db.saleReturn.findMany({ where: { saleId: sale.id }, orderBy: { number: "asc" }, select: { id: true, number: true, refundTotal: true, createdAt: true, createdByName: true } }),
  ]);
  const nothingLeft = lines.every((line) => line.returnable === "0.000");
  const blocked = sale.cancelled
    ? "This sale was cancelled, so nothing of it can be returned."
    : lastDay && shopToday() > lastDay
      ? `This sale is too old: its goods could be returned until ${lastDay.split("-").reverse().join("/")}. An admin can change the number of days allowed in Settings.`
      : nothingLeft
        ? "Everything on this sale has already been returned."
        : null;
  return {
    sale: { id: sale.id, receiptNumber: sale.receiptNumber, soldAt: sale.createdAt, cashierName: sale.cashierName, customerName: sale.customerName, terminalId: sale.terminalId },
    lines: lines.map((line) => ({
      saleLineId: line.saleLineId,
      lineNumber: line.lineNumber,
      productId: line.productId,
      productName: line.productName,
      unitName: line.unitName,
      unitFactor: line.unitFactor,
      allowsFraction: line.allowsFraction,
      sold: line.sold,
      returned: line.returned,
      returnable: line.returnable,
      paid: line.paid,
      refunded: line.refunded,
    })),
    blocked,
    owedOnSale: moneyToString(owed),
    paymentMethods,
    openTills: tills.map((till) => ({ terminalId: till.terminal.id, code: till.terminal.code, name: till.terminal.name })).sort((a, b) => a.code.localeCompare(b.code)),
    hasStoreroom: locations.some((location) => location.kind === "STOREROOM"),
    needsApproval: !can(context, "return.approve"),
    earlier: earlier.map((row) => ({ id: row.id, number: row.number, refundTotal: row.refundTotal.toFixed(2), createdAt: row.createdAt, createdByName: row.createdByName })),
  };
}

const postSchema = returnSchema.extend({
  /** The approval a manager gave for exactly this return, unless the person may approve returns themselves. */
  approvalId: z.string().trim().optional().default(""),
});

export type ReturnResult = { id: string; number: number; refundTotal: string; debtReduced: string; refundPaid: string; alreadySaved: boolean };

/**
 * Saves a return: the returned goods, the stock coming back, the customer's debt on that
 * sale reduced, and the rest of the refund handed back — all of it, or none of it. Sending
 * the same `requestId` again returns the return already saved.
 *
 * Refused when: more would come back than was sold and not yet returned; the sale was
 * cancelled or is too old; the person needs an approval and has none that fits; a cash
 * refund has no open till, or the till should not hold that much.
 */
export async function postReturn(context: AppContext, input: unknown): Promise<ReturnResult> {
  authorize(context, "return.request");
  const businessId = businessIdOf(context);
  const data = parseInput(postSchema, input);
  const db = businessDb(context);

  const alreadySaved = async (): Promise<ReturnResult | null> => {
    const saved = await db.saleReturn.findFirst({ where: { requestId: data.requestId } });
    return saved
      ? { id: saved.id, number: saved.number, refundTotal: saved.refundTotal.toFixed(2), debtReduced: saved.debtReduced.toFixed(2), refundPaid: saved.refundPaid.toFixed(2), alreadySaved: true }
      : null;
  };
  const repeat = await alreadySaved();
  if (repeat) return repeat;

  // A first look, outside the transaction, so that plain mistakes are answered without taking any turn.
  const first = await workOutReturn(db, data, NOT_RETURNED);
  const method = data.refundMethodId
    ? await db.paymentMethod.findFirst({ where: { id: data.refundMethodId }, select: { id: true, name: true, kind: true, deactivatedAt: true } })
    : null;
  if (data.refundMethodId && (!method || method.deactivatedAt)) {
    throw new ValidationError(NOT_RETURNED, { refundMethodId: "Choose how the money is handed back." });
  }
  const cashTerminal =
    method?.kind === "CASH" ? await db.terminal.findFirst({ where: { id: data.terminalId }, select: { id: true, code: true } }) : null;
  if (method?.kind === "CASH" && !cashTerminal) throw new ValidationError(NOT_RETURNED, { terminalId: "Choose the checkout whose till the cash comes out of." });
  const productOrder = [...new Set(first.lines.map((line) => line.productId))].sort();

  const save = () =>
    db.$transaction(
      async (tx) => {
        const number = await takeDocumentNumber(tx, businessId, "SALE_RETURN");
        // A cash refund takes the terminal's turn, like every other movement of its drawer.
        if (cashTerminal) await tx.terminal.update({ where: { id: cashTerminal.id }, data: { updatedAt: new Date() }, select: { id: true } });
        // The customer's turn, then the products', in the order every stock change uses. Two
        // returns of the same goods therefore go one after the other.
        if (first.sale.customerId) await tx.customer.update({ where: { id: first.sale.customerId }, data: { updatedAt: new Date() }, select: { id: true } });
        const costNow = new Map<string, Decimal>();
        for (const productId of productOrder) {
          const product = await tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() }, select: { averageCost: true } });
          costNow.set(productId, new Decimal(product.averageCost.toFixed(4)));
        }

        // Worked out again now that nobody else can be returning the same goods.
        const worked = await workOutReturn(tx, data, NOT_RETURNED);
        const { sale, lines, refundTotal } = worked;

        let approvedBy = { userId: context.actor.userId as string | null, name: context.actor.name };
        let approvalId: string | null = null;
        if (!can(context, "return.approve")) {
          const approval = await claimApproval(tx, {
            id: data.approvalId,
            kind: "RETURN",
            saleRequestId: data.requestId,
            fingerprint: worked.fingerprint,
            field: "approvalId",
            missing: "A manager or admin must approve this return before it can be saved.",
            nothingSaved: NOT_RETURNED,
            what: "return",
          });
          approvalId = approval.id;
          approvedBy = { userId: approval.approvedByUserId, name: approval.approvedByName };
        }

        // The refund comes off what is still owed on this sale first; the rest is handed back.
        const debtReduced = Decimal.min(refundTotal, await owedOnSale(tx, sale));
        const refundPaid = refundTotal.minus(debtReduced);
        if (refundPaid.greaterThan(0) && !method) {
          throw new ValidationError(NOT_RETURNED, { refundMethodId: `Choose how the ${formatNaira(refundPaid)} is handed back.` });
        }
        let tillSessionId: string | null = null;
        if (refundPaid.greaterThan(0) && method?.kind === "CASH") {
          const till = await tx.tillSession.findFirst({ where: { terminalId: cashTerminal!.id, close: null }, select: { id: true, openingFloat: true } });
          if (!till) throw new ValidationError(NOT_RETURNED, { terminalId: `The till of ${cashTerminal!.code} is not open, and the cash has to come out of it.` });
          const holds = new Decimal(till.openingFloat.toFixed(2)).plus((await drawerMovements(tx, till.id)).net);
          if (holds.lessThan(refundPaid)) {
            throw new ValidationError(NOT_RETURNED, {
              terminalId: `${formatNaira(refundPaid)} in cash has to be given back, but the till of ${cashTerminal!.code} should only hold ${formatNaira(holds)}.`,
            });
          }
          tillSessionId = till.id;
        }

        let owedAfter: Decimal | null = null;
        if (debtReduced.greaterThan(0) && sale.customerId) {
          const lowered = await tx.customer.updateMany({
            where: { id: sale.customerId, balance: { gte: moneyToString(debtReduced) } },
            data: { balance: { decrement: moneyToString(debtReduced) } },
          });
          if (lowered.count !== 1) throw new Error("The customer owes less than is still owed on this sale.");
          const now = await tx.customer.findFirst({ where: { id: sale.customerId }, select: { balance: true } });
          owedAfter = new Decimal(now?.balance.toFixed(2) ?? "0");
        }

        // Goods put back come back at the cost they left with; written-off goods do not come back at all.
        const restocked = lines.filter((line) => line.location);
        for (const productId of productOrder) {
          const back = restocked.filter((line) => line.productId === productId);
          if (back.length === 0) continue;
          const before = await tx.stockBalance.aggregate({ where: { productId }, _sum: { quantity: true } });
          const average = movingAverageCost({
            quantityBefore: new Decimal(before._sum.quantity?.toFixed(3) ?? "0"),
            averageBefore: costNow.get(productId)!,
            quantityAdded: back.reduce((sum, line) => sum.plus(line.baseQuantity), new Decimal(0)),
            costAdded: sumMoney(back.map((line) => line.lineCost)),
          });
          await tx.product.update({ where: { id: productId }, data: { averageCost: average.toFixed(4) } });
          const perPlace = new Map<string, Decimal>();
          for (const line of back) perPlace.set(line.location!.id, (perPlace.get(line.location!.id) ?? new Decimal(0)).plus(line.baseQuantity));
          for (const [locationId, quantity] of [...perPlace.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            const raised = await tx.stockBalance.updateMany({ where: { productId, locationId }, data: { quantity: { increment: quantityToString(quantity) } } });
            if (raised.count === 0) await tx.stockBalance.create({ data: { businessId, productId, locationId, quantity: quantityToString(quantity) } });
          }
        }

        const saved = await tx.saleReturn.create({
          data: {
            businessId,
            requestId: data.requestId,
            number,
            saleId: sale.id,
            saleReceiptNumber: sale.receiptNumber,
            customerId: sale.customerId,
            customerName: sale.customerName,
            reason: data.reason,
            refundTotal: moneyToString(refundTotal),
            debtReduced: moneyToString(debtReduced),
            refundPaid: moneyToString(refundPaid),
            refundMethodId: refundPaid.greaterThan(0) ? method!.id : null,
            refundMethodName: refundPaid.greaterThan(0) ? method!.name : null,
            refundKind: refundPaid.greaterThan(0) ? method!.kind : null,
            refundReference: refundPaid.greaterThan(0) && method!.kind !== "CASH" ? data.refundReference || null : null,
            tillSessionId,
            restockedCost: moneyToString(sumMoney(restocked.map((line) => line.lineCost))),
            writtenOffCost: moneyToString(sumMoney(lines.filter((line) => !line.location).map((line) => line.lineCost))),
            createdByUserId: context.actor.userId,
            createdByName: context.actor.name,
            approvedByUserId: approvedBy.userId,
            approvedByName: approvedBy.name,
          },
        });
        const documentNumber = returnNumber(number);
        await tx.saleReturnLine.createMany({
          data: lines.map((line) => ({
            businessId,
            returnId: saved.id,
            saleLineId: line.saleLineId,
            lineNumber: line.lineNumber,
            productId: line.productId,
            productName: line.productName,
            unitName: line.unitName,
            unitFactor: line.unitFactor,
            quantity: quantityToString(line.quantity),
            baseQuantity: quantityToString(line.baseQuantity),
            refundAmount: moneyToString(line.refundAmount),
            taxAmount: moneyToString(line.taxAmount),
            lineCost: moneyToString(line.lineCost),
            disposition: line.disposition,
            locationId: line.location?.id ?? null,
            locationName: line.location?.name ?? null,
          })),
        });
        if (restocked.length > 0) {
          await tx.stockMovement.createMany({
            data: restocked.map((line) => ({
              businessId,
              productId: line.productId,
              locationId: line.location!.id,
              type: "SALE_RETURN" as const,
              quantityDelta: quantityToString(line.baseQuantity),
              unitName: line.unitName,
              unitFactor: line.unitFactor,
              unitQuantity: quantityToString(line.quantity),
              documentType: "sale_return",
              documentId: saved.id,
              documentNumber,
              userId: context.actor.userId,
              userName: context.actor.name,
            })),
          });
        }
        if (debtReduced.greaterThan(0) && sale.customerId) {
          await tx.customerAccountEntry.create({
            data: {
              businessId,
              customerId: sale.customerId,
              type: "SALE_RETURN",
              amount: moneyToString(debtReduced.negated()),
              balanceAfter: moneyToString(owedAfter!),
              saleId: sale.id,
              documentNumber,
              note: data.reason,
              createdByUserId: context.actor.userId,
              createdByName: context.actor.name,
            },
          });
        }
        // Someone who may approve returns is recorded as approving their own, so the report is complete.
        if (!approvalId) {
          const own = await tx.approval.create({
            data: {
              businessId,
              kind: "RETURN",
              method: "OWN_SALE",
              saleRequestId: data.requestId,
              fingerprint: worked.fingerprint,
              amount: moneyToString(Decimal.max(refundTotal, new Decimal("0.01"))),
              basis: moneyToString(refundTotal),
              reason: data.reason,
              requestedByUserId: context.actor.userId,
              requestedByName: context.actor.name,
              approvedByUserId: context.actor.userId,
              approvedByName: context.actor.name,
              expiresAt: new Date(Date.now() + APPROVAL_MINUTES * 60_000),
            },
            select: { id: true },
          });
          approvalId = own.id;
        }
        await tx.approvalUse.create({ data: { businessId, approvalId, saleId: sale.id } });
        await tx.activityLog.create({
          data: activityRow(context, {
            action: "sale.returned",
            summary:
              `${context.actor.name} took back goods from sale ${sale.receiptNumber} (${documentNumber}): ${formatNaira(refundTotal)} refunded` +
              `${debtReduced.greaterThan(0) ? `, ${formatNaira(debtReduced)} of it off the customer's debt` : ""}` +
              `${approvedBy.name !== context.actor.name ? `; approved by ${approvedBy.name}` : ""}. Reason: ${data.reason}`,
            targetType: "sale_return",
            targetId: saved.id,
          }),
        });
        return {
          id: saved.id,
          number,
          refundTotal: moneyToString(refundTotal),
          debtReduced: moneyToString(debtReduced),
          refundPaid: moneyToString(refundPaid),
          alreadySaved: false,
        };
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );

  for (let attempt = 1; ; attempt++) {
    try {
      return await save();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
      if (known === "P2002") {
        const saved = await alreadySaved();
        if (saved) return saved;
      }
      if (known === "P2034" && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Reading returns
// ---------------------------------------------------------------------------

/** Those who read sales reports see every return; others only the ones they entered. */
function ownOnly(context: AppContext): Prisma.SaleReturnWhereInput {
  return can(context, "report.sales.view") ? {} : { createdByUserId: context.actor.userId };
}

export type ReturnDetail = {
  id: string;
  number: number;
  createdAt: Date;
  createdByName: string;
  approvedByName: string;
  sale: { id: string; receiptNumber: string };
  customerName: string | null;
  reason: string;
  refundTotal: string;
  debtReduced: string;
  refundPaid: string;
  refundMethodName: string | null;
  refundReference: string | null;
  lines: { lineNumber: number; productName: string; unitName: string; quantity: string; refundAmount: string; disposition: Disposition; locationName: string | null }[];
  /** The cost of what was written off — only for those who may see cost prices. */
  writtenOffCost: string | null;
  paperWidth: "MM58" | "MM80";
  business: { name: string; receiptHeader: string | null; receiptFooter: string | null; taxNumber: string | null; autoPrintReceipts: boolean };
  /** True when this person may open the sale it refers to. */
  canOpenSale: boolean;
};

/** One return with everything its slip shows. */
export async function getReturn(context: AppContext, input: unknown): Promise<ReturnDetail> {
  if (!can(context, "report.sales.view")) authorize(context, "return.request");
  const { returnId } = parseInput(z.object({ returnId: z.string().uuid("That return could not be found.") }), input);
  const db = businessDb(context);
  const [row, business] = await Promise.all([
    db.saleReturn.findFirst({
      where: { id: returnId, ...ownOnly(context) },
      include: { lines: { orderBy: { lineNumber: "asc" } }, sale: { select: { cashierUserId: true, terminal: { select: { paperWidth: true } } } } },
    }),
    db.business.findFirst({ select: { name: true, receiptHeader: true, receiptFooter: true, taxNumber: true, autoPrintReceipts: true } }),
  ]);
  if (!row || !business) throw new NotFoundError("That return could not be found.");
  return {
    id: row.id,
    number: row.number,
    createdAt: row.createdAt,
    createdByName: row.createdByName,
    approvedByName: row.approvedByName,
    sale: { id: row.saleId, receiptNumber: row.saleReceiptNumber },
    customerName: row.customerName,
    reason: row.reason,
    refundTotal: row.refundTotal.toFixed(2),
    debtReduced: row.debtReduced.toFixed(2),
    refundPaid: row.refundPaid.toFixed(2),
    refundMethodName: row.refundMethodName,
    refundReference: row.refundReference,
    lines: row.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productName: line.productName,
      unitName: line.unitName,
      quantity: line.quantity.toFixed(3),
      refundAmount: line.refundAmount.toFixed(2),
      disposition: line.disposition,
      locationName: line.locationName,
    })),
    writtenOffCost: can(context, "cost.view") ? row.writtenOffCost.toFixed(2) : null,
    paperWidth: row.sale.terminal.paperWidth,
    business,
    canOpenSale: can(context, "report.sales.view") || row.sale.cashierUserId === context.actor.userId,
  };
}

const listSchema = z.object({
  search: z.string().trim().max(120).optional().default(""),
  from: z.string().trim().optional().default(""),
  to: z.string().trim().optional().default(""),
  page: pageNumber,
});

export type ReturnSummary = {
  id: string;
  number: number;
  createdAt: Date;
  saleReceiptNumber: string;
  customerName: string | null;
  createdByName: string;
  approvedByName: string;
  reason: string;
  refundTotal: string;
  /** True when some of what came back was written off as damaged. */
  hasWriteOff: boolean;
};

/** One page of returns, newest first, with the total refunded by all that match. */
export async function listReturns(
  context: AppContext,
  input: unknown = {},
): Promise<{ returns: ReturnSummary[]; sumOfRefunds: string; ownOnly: boolean } & Paged> {
  if (!can(context, "report.sales.view")) authorize(context, "return.request");
  const { search, from, to, page } = parseInput(listSchema, input);
  const start = shopDayStart(from);
  const end = shopDayEnd(to);
  const where: Prisma.SaleReturnWhereInput = {
    ...ownOnly(context),
    ...(start || end ? { createdAt: { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) } } : {}),
    ...(search
      ? {
          OR: [
            { saleReceiptNumber: { contains: search } },
            { customerName: { contains: search } },
            { createdByName: { contains: search } },
            { reason: { contains: search } },
            { lines: { some: { productName: { contains: search } } } },
          ],
        }
      : {}),
  };
  const db = businessDb(context);
  const [total, sum, rows] = await Promise.all([
    db.saleReturn.count({ where }),
    db.saleReturn.aggregate({ where, _sum: { refundTotal: true } }),
    db.saleReturn.findMany({
      where,
      orderBy: [{ number: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { lines: { where: { disposition: "WRITTEN_OFF" }, select: { id: true }, take: 1 } },
    }),
  ]);
  return {
    ownOnly: !can(context, "report.sales.view"),
    sumOfRefunds: (sum._sum.refundTotal ?? new Decimal(0)).toFixed(2),
    returns: rows.map((row) => ({
      id: row.id,
      number: row.number,
      createdAt: row.createdAt,
      saleReceiptNumber: row.saleReceiptNumber,
      customerName: row.customerName,
      createdByName: row.createdByName,
      approvedByName: row.approvedByName,
      reason: row.reason,
      refundTotal: row.refundTotal.toFixed(2),
      hasWriteOff: row.lines.length > 0,
    })),
    ...paged(total, page),
  };
}
