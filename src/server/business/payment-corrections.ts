import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { tillSessionNumber } from "@/lib/format";
import { formatNaira } from "@/lib/money";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { optionalText } from "@/server/input";
import { withCorrections } from "@/server/payment-corrections";
import { authorize } from "@/server/permissions";
import { drawerMovements } from "@/server/till-cash";

/**
 * Correcting HOW a sale was paid (C81): the cashier chose the wrong way of paying, and an admin
 * or manager puts it right with a reason. The payment is never changed; a `payment_correction`
 * row is written beside it, and the activity log says what was entered and what it became.
 *
 * Allowed only while the till the money went into is still open — a closed, counted till never
 * changes afterwards — and not for a cancelled sale. Like every cash transaction it takes the
 * terminal's turn first, so it cannot cross a sale, a cancellation or the till's closing.
 */

const schema = z.object({
  requestId: z.string().uuid("This form has expired. Reload the page and try again."),
  paymentId: z.string().uuid("That payment could not be found."),
  methodId: z.string().trim().min(1, "Choose how it was really paid."),
  reference: optionalText(60, "The reference is too long (60 characters at most).").optional().default(""),
  reason: z.string().trim().min(1, "Say why the way of paying is being corrected.").max(300, "The reason is too long (300 characters at most)."),
});

const NOT_SAVED = "Nothing was changed.";

export async function correctPayment(context: AppContext, input: unknown): Promise<{ id: string; saleId: string; alreadySaved: boolean }> {
  authorize(context, "payment.correct");
  const businessId = businessIdOf(context);
  const data = parseInput(schema, input);
  const db = businessDb(context);

  const saved = async () => {
    const row = await db.paymentCorrection.findFirst({ where: { requestId: data.requestId }, select: { id: true, saleId: true } });
    return row ? { id: row.id, saleId: row.saleId, alreadySaved: true } : null;
  };
  const earlier = await saved();
  if (earlier) return earlier;

  const payment = await db.payment.findFirst({
    where: { id: data.paymentId },
    select: {
      id: true,
      saleId: true,
      methodId: true,
      methodName: true,
      kind: true,
      reference: true,
      amount: true,
      tillSessionId: true,
      sale: { select: { receiptNumber: true, terminalId: true } },
    },
  });
  if (!payment) throw new NotFoundError("That payment could not be found.");
  if (!payment.tillSessionId) {
    throw new ValidationError(`${NOT_SAVED} This payment was not taken into a till (it was brought in from Excel), so it cannot be corrected here.`);
  }
  const method = await db.paymentMethod.findFirst({ where: { id: data.methodId, deactivatedAt: null }, select: { id: true, name: true, kind: true } });
  if (!method) throw new ValidationError(NOT_SAVED, { methodId: "Choose a way of paying that is in use." });
  const amount = new Decimal(payment.amount.toFixed(2));
  const sessionId = payment.tillSessionId;

  try {
    return await db.$transaction(
      async (tx) => {
        // The terminal's turn: no sale, cancellation or closing of this till can cross this.
        await tx.terminal.update({ where: { id: payment.sale.terminalId }, data: { updatedAt: new Date() }, select: { id: true } });
        const session = await tx.tillSession.findFirst({
          where: { id: sessionId },
          select: { id: true, number: true, openingFloat: true, close: { select: { id: true } } },
        });
        if (!session || session.close) {
          throw new ValidationError(`${NOT_SAVED} The till this sale was paid into (${session ? tillSessionNumber(session.number) : "its till"}) has already been closed and counted, so how it was paid can no longer be corrected.`);
        }
        if (await tx.saleCancellation.findFirst({ where: { saleId: payment.saleId }, select: { id: true } })) {
          throw new ValidationError(`${NOT_SAVED} This sale has been cancelled.`);
        }
        const [current] = await withCorrections(tx, [payment]);
        if (current.methodId === method.id) {
          throw new ValidationError(NOT_SAVED, { methodId: `It is already recorded as ${method.name}.` });
        }
        // Cash that never came in: the drawer must not be expected to hold less than nothing.
        if (current.kind === "CASH" && method.kind !== "CASH") {
          const drawer = await drawerMovements(tx, session.id);
          const holds = new Decimal(session.openingFloat.toFixed(2)).plus(drawer.net);
          if (holds.lessThan(amount)) {
            throw new ValidationError(`${NOT_SAVED} The till should only hold ${formatNaira(holds)} in cash, less than this payment.`);
          }
        }
        const correction = await tx.paymentCorrection.create({
          data: {
            businessId,
            requestId: data.requestId,
            paymentId: payment.id,
            saleId: payment.saleId,
            tillSessionId: session.id,
            amount: amount.toFixed(2),
            fromMethodId: current.methodId,
            fromMethodName: current.methodName,
            fromKind: current.kind,
            toMethodId: method.id,
            toMethodName: method.name,
            toKind: method.kind,
            toReference: method.kind === "CASH" ? null : data.reference || null,
            reason: data.reason,
            correctedByUserId: context.actor.userId,
            correctedByName: context.actor.name,
          },
          select: { id: true },
        });
        await tx.activityLog.create({
          data: activityRow(context, {
            action: "sale.payment_corrected",
            summary:
              `${context.actor.name} corrected how receipt ${payment.sale.receiptNumber} was paid: ${formatNaira(amount)} ` +
              `entered as ${current.methodName}, corrected to ${method.name}. Reason: ${data.reason}`,
            targetType: "sale",
            targetId: payment.saleId,
            details: { paymentId: payment.id, from: current.methodName, to: method.name, amount: amount.toFixed(2) },
          }),
        });
        return { id: correction.id, saleId: payment.saleId, alreadySaved: false };
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
