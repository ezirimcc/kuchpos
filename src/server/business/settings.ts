import "server-only";
import { z } from "zod";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { MAX_IDLE_SIGN_OUT_MINUTES, MIN_IDLE_SIGN_OUT_MINUTES } from "@/server/auth/config";
import { parseInput } from "@/server/auth/users";
import { businessDb } from "@/server/db/scoped";
import { NotFoundError } from "@/server/errors";
import { authorize } from "@/server/permissions";

/** Settings of the business in use. */

export type BusinessSettings = {
  name: string;
  idleSignOutMinutes: number;
};

export async function getBusinessSettings(context: AppContext): Promise<BusinessSettings> {
  authorize(context, "settings.manage");
  const business = await businessDb(context).business.findFirst({
    select: { name: true, idleSignOutMinutes: true },
  });
  if (!business) throw new NotFoundError("That business could not be found.");
  return business;
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
