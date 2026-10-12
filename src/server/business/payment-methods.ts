import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { PAYMENT_KIND_VALUES, type PaymentKindValue, paymentKindLabel } from "@/lib/payment-kinds";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { authorize } from "@/server/permissions";
import { isStillReferred, paymentMethodWasUsed, usedAmong } from "@/server/usage";

/**
 * The ways customers pay, as each business names them (SPEC C46): "Cash", "Transfer – GTBank",
 * "POS – Moniepoint"… Managed by the admin on the Settings screen.
 *
 * A method's kind (cash, bank transfer, POS) is fixed when it is created, because the till
 * count depends on it. A method is never deleted; it is switched off. Every payment keeps
 * its own copy of the method's name, so renaming a method does not rewrite old receipts.
 */

export type PaymentMethodView = {
  id: string;
  name: string;
  kind: PaymentKindValue;
  /** True for the "Cash" every business starts with, which cannot be switched off. */
  builtIn: boolean;
  active: boolean;
  /** True for a method (never "Cash") that has taken no payment, refund or repayment: it may be deleted (C67). */
  canDelete: boolean;
};

const FIX_FIELDS = "Nothing was saved. Please correct the highlighted fields.";
const NAME_TAKEN = "This business already has a payment method with that name.";

const nameSchema = z
  .string()
  .trim()
  .min(2, "Enter a name of at least 2 characters, for example: Transfer – GTBank.")
  .max(60, "The name is too long (60 characters at most).");

export async function listPaymentMethods(context: AppContext): Promise<PaymentMethodView[]> {
  authorize(context, "settings.manage");
  const db = businessDb(context);
  const rows = await db.paymentMethod.findMany({
    orderBy: [{ builtIn: "desc" }, { name: "asc" }],
    select: { id: true, name: true, kind: true, builtIn: true, deactivatedAt: true },
  });
  const used = await usedAmong(rows.filter((row) => !row.builtIn).map((row) => row.id), (id) => paymentMethodWasUsed(db, id));
  return rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, builtIn: row.builtIn, active: row.deactivatedAt === null, canDelete: !row.builtIn && !used.has(row.id) }));
}

function isNameTaken(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const createSchema = z.object({
  name: nameSchema,
  kind: z.enum(PAYMENT_KIND_VALUES, { message: "Choose what kind of payment this is." }),
});

export async function createPaymentMethod(context: AppContext, input: unknown): Promise<{ id: string }> {
  authorize(context, "settings.manage");
  const businessId = businessIdOf(context);
  const data = parseInput(createSchema, input);

  try {
    return await businessDb(context).$transaction(async (tx) => {
      const method = await tx.paymentMethod.create({ data: { businessId, name: data.name, kind: data.kind } });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "payment_method.created",
          summary: `${context.actor.name} added the payment method "${method.name}" (${paymentKindLabel(method.kind)}).`,
          targetType: "payment_method",
          targetId: method.id,
        }),
      });
      return { id: method.id };
    });
  } catch (error) {
    if (isNameTaken(error)) throw new ValidationError(FIX_FIELDS, { name: NAME_TAKEN });
    throw error;
  }
}

const renameSchema = z.object({
  methodId: z.string().uuid("That payment method could not be found."),
  name: nameSchema,
});

/** Renames a payment method. Payments already taken keep the name they were taken under. */
export async function renamePaymentMethod(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "settings.manage");
  const data = parseInput(renameSchema, input);

  try {
    await businessDb(context).$transaction(async (tx) => {
      const method = await tx.paymentMethod.findFirst({ where: { id: data.methodId } });
      if (!method) throw new NotFoundError("That payment method could not be found.");
      if (method.name === data.name) return;

      await tx.paymentMethod.update({ where: { id: method.id }, data: { name: data.name } });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "payment_method.renamed",
          summary: `${context.actor.name} renamed the payment method "${method.name}" to "${data.name}".`,
          targetType: "payment_method",
          targetId: method.id,
        }),
      });
    });
  } catch (error) {
    if (isNameTaken(error)) throw new ValidationError(FIX_FIELDS, { name: NAME_TAKEN });
    throw error;
  }
}

const setActiveSchema = z.object({
  methodId: z.string().uuid("That payment method could not be found."),
  active: z.boolean(),
});

/** Switches a payment method off (it is no longer offered at checkout) or back on. "Cash" stays on. */
export async function setPaymentMethodActive(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "settings.manage");
  const data = parseInput(setActiveSchema, input);

  await businessDb(context).$transaction(async (tx) => {
    const method = await tx.paymentMethod.findFirst({ where: { id: data.methodId } });
    if (!method) throw new NotFoundError("That payment method could not be found.");
    if ((method.deactivatedAt === null) === data.active) return;
    if (method.builtIn && !data.active) {
      throw new ValidationError("Cash is always available and cannot be switched off.");
    }

    await tx.paymentMethod.update({ where: { id: method.id }, data: { deactivatedAt: data.active ? null : new Date() } });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: data.active ? "payment_method.reactivated" : "payment_method.deactivated",
        summary: `${context.actor.name} switched ${data.active ? "on" : "off"} the payment method "${method.name}".`,
        targetType: "payment_method",
        targetId: method.id,
      }),
    });
  });
}

const METHOD_WAS_USED = "This payment method cannot be deleted because payments were taken with it. Switch it off instead.";

/**
 * Deletes, for good, a payment method that has never taken a payment or a repayment or given
 * a refund (C67). "Cash" can never be deleted; a method that was used can only be switched off.
 */
export async function deletePaymentMethod(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "settings.manage");
  const data = parseInput(z.object({ methodId: z.string().uuid("That payment method could not be found.") }), input);

  try {
    await businessDb(context).$transaction(async (tx) => {
      const method = await tx.paymentMethod.findFirst({ where: { id: data.methodId }, select: { id: true, name: true, builtIn: true } });
      if (!method) throw new NotFoundError("That payment method could not be found.");
      if (method.builtIn) throw new ValidationError("Cash is always available and cannot be deleted.");
      if (await paymentMethodWasUsed(tx, method.id)) throw new ValidationError(METHOD_WAS_USED);

      await tx.paymentMethod.delete({ where: { id: method.id } });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "payment_method.deleted",
          summary: `${context.actor.name} deleted the payment method "${method.name}", which had never been used.`,
          targetType: "payment_method",
          targetId: method.id,
        }),
      });
    });
  } catch (error) {
    if (isStillReferred(error)) throw new ValidationError(METHOD_WAS_USED);
    throw error;
  }
}
