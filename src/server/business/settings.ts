import "server-only";
import { z } from "zod";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { MAX_IDLE_SIGN_OUT_MINUTES, MIN_IDLE_SIGN_OUT_MINUTES } from "@/server/auth/config";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { percentText } from "@/server/input";
import { NotFoundError, ValidationError } from "@/server/errors";
import { authorize } from "@/server/permissions";

/** Settings of the business in use. */

export type TaxRateChangeView = {
  id: string;
  createdAt: Date;
  oldRatePercent: string;
  newRatePercent: string;
  changedByName: string;
};

export type BusinessSettings = {
  name: string;
  idleSignOutMinutes: number;
  /** Tax rate in percent as text with 2 decimal places, e.g. "7.50". */
  taxRatePercent: string;
  receiptHeader: string;
  receiptFooter: string;
  /** How many months ahead an expiry date counts as "expiring soon". */
  expiringSoonMonths: number;
  taxRateHistory: TaxRateChangeView[];
};

export async function getBusinessSettings(context: AppContext): Promise<BusinessSettings> {
  authorize(context, "settings.manage");
  const db = businessDb(context);
  const business = await db.business.findFirst({
    select: {
      name: true,
      idleSignOutMinutes: true,
      taxRatePercent: true,
      receiptHeader: true,
      receiptFooter: true,
      expiringSoonMonths: true,
    },
  });
  if (!business) throw new NotFoundError("That business could not be found.");
  const history = await db.taxRateChange.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, createdAt: true, oldRatePercent: true, newRatePercent: true, changedByName: true },
  });
  return {
    name: business.name,
    idleSignOutMinutes: business.idleSignOutMinutes,
    taxRatePercent: business.taxRatePercent.toFixed(2),
    receiptHeader: business.receiptHeader ?? "",
    receiptFooter: business.receiptFooter ?? "",
    expiringSoonMonths: business.expiringSoonMonths,
    taxRateHistory: history.map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      oldRatePercent: entry.oldRatePercent.toFixed(2),
      newRatePercent: entry.newRatePercent.toFixed(2),
      changedByName: entry.changedByName,
    })),
  };
}

const RANGE_MESSAGE = `Enter a whole number of minutes from ${MIN_IDLE_SIGN_OUT_MINUTES} to ${MAX_IDLE_SIGN_OUT_MINUTES}.`;

const idleSignOutSchema = z.object({
  minutes: z
    .string()
    .trim()
    .regex(/^\d{1,4}$/, RANGE_MESSAGE)
    .transform((text) => Number.parseInt(text, 10))
    .pipe(z.number().min(MIN_IDLE_SIGN_OUT_MINUTES, RANGE_MESSAGE).max(MAX_IDLE_SIGN_OUT_MINUTES, RANGE_MESSAGE)),
});

/** Sets how long a staff screen may sit unused before it asks for the password again. */
export async function setIdleSignOutMinutes(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "settings.manage");
  const { minutes } = parseInput(idleSignOutSchema, input);

  await businessDb(context).$transaction(async (tx) => {
    const business = await tx.business.findFirst({ select: { id: true, idleSignOutMinutes: true } });
    if (!business) throw new NotFoundError("That business could not be found.");
    if (business.idleSignOutMinutes === minutes) return;

    await tx.business.update({ where: { id: business.id }, data: { idleSignOutMinutes: minutes } });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "settings.idle_sign_out_changed",
        summary: `${context.actor.name} changed automatic sign-out from ${business.idleSignOutMinutes} to ${minutes} minutes.`,
        targetType: "business",
        targetId: business.id,
        details: { from: business.idleSignOutMinutes, to: minutes },
      }),
    });
  });
}

const taxRateSchema = z.object({ ratePercent: percentText("tax rate") });

/**
 * Sets the business's tax rate. It applies to sales made from now on; past sales keep
 * the rate they were sold at. Prices already include tax, so this changes how much of
 * each price is tax — not what the customer pays.
 */
export async function setTaxRate(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "settings.manage");
  const businessId = businessIdOf(context);
  const { ratePercent } = parseInput(taxRateSchema, input);

  await businessDb(context).$transaction(async (tx) => {
    const business = await tx.business.findFirst({ select: { id: true, taxRatePercent: true } });
    if (!business) throw new NotFoundError("That business could not be found.");
    const oldRate = business.taxRatePercent.toFixed(2);
    if (oldRate === ratePercent) return;

    // Only succeeds if the rate is still what was just read; otherwise someone else changed it.
    const updated = await tx.business.updateMany({
      where: { taxRatePercent: business.taxRatePercent },
      data: { taxRatePercent: ratePercent },
    });
    if (updated.count !== 1) {
      throw new ValidationError("Someone else changed the tax rate a moment ago. Check the current rate and try again.");
    }
    await tx.taxRateChange.create({
      data: {
        businessId,
        oldRatePercent: oldRate,
        newRatePercent: ratePercent,
        changedByUserId: context.actor.userId,
        changedByName: context.actor.name,
      },
    });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "settings.tax_rate_changed",
        summary: `${context.actor.name} changed the tax rate from ${oldRate}% to ${ratePercent}%.`,
        targetType: "business",
        targetId: business.id,
        details: { from: oldRate, to: ratePercent },
      }),
    });
  });
}

const receiptTextSchema = z.object({
  header: z.string().trim().max(500, "The top text is too long (500 characters at most)."),
  footer: z.string().trim().max(500, "The bottom text is too long (500 characters at most)."),
});

/** Sets the lines printed at the top and bottom of every receipt. */
export async function setReceiptText(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "settings.manage");
  const data = parseInput(receiptTextSchema, input);

  await businessDb(context).$transaction(async (tx) => {
    const business = await tx.business.findFirst({ select: { id: true, receiptHeader: true, receiptFooter: true } });
    if (!business) throw new NotFoundError("That business could not be found.");
    if ((business.receiptHeader ?? "") === data.header && (business.receiptFooter ?? "") === data.footer) return;

    await tx.business.update({
      where: { id: business.id },
      data: { receiptHeader: data.header || null, receiptFooter: data.footer || null },
    });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "settings.receipt_text_changed",
        summary: `${context.actor.name} changed the text printed on receipts.`,
        targetType: "business",
        targetId: business.id,
      }),
    });
  });
}

const MIN_EXPIRING_MONTHS = 1;
const MAX_EXPIRING_MONTHS = 36;
const MONTHS_MESSAGE = `Enter a whole number of months from ${MIN_EXPIRING_MONTHS} to ${MAX_EXPIRING_MONTHS}.`;

const expiringSoonSchema = z.object({
  months: z
    .string()
    .trim()
    .regex(/^\d{1,2}$/, MONTHS_MESSAGE)
    .transform((text) => Number.parseInt(text, 10))
    .pipe(z.number().min(MIN_EXPIRING_MONTHS, MONTHS_MESSAGE).max(MAX_EXPIRING_MONTHS, MONTHS_MESSAGE)),
});

/** Sets how many months ahead an expiry date counts as "expiring soon". */
export async function setExpiringSoonMonths(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "settings.manage");
  const { months } = parseInput(expiringSoonSchema, input);

  await businessDb(context).$transaction(async (tx) => {
    const business = await tx.business.findFirst({ select: { id: true, expiringSoonMonths: true } });
    if (!business) throw new NotFoundError("That business could not be found.");
    if (business.expiringSoonMonths === months) return;

    await tx.business.update({ where: { id: business.id }, data: { expiringSoonMonths: months } });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "settings.expiring_soon_changed",
        summary: `${context.actor.name} changed "expiring soon" from ${business.expiringSoonMonths} to ${months} months.`,
        targetType: "business",
        targetId: business.id,
        details: { from: business.expiringSoonMonths, to: months },
      }),
    });
  });
}
