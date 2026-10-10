"use server";

import type { FormState } from "@/lib/form-state";
import { runAction } from "@/server/action";
import { closeTill, decideTillCash, openTill, recountTill, requestTillCash, withdrawTillCash } from "@/server/business/till";

export async function openTillAction(input: unknown): Promise<FormState> {
  return runAction({ success: "Till opened." }, (context) => openTill(context, input));
}

/** Closes a till session. On success the answer carries the session's id so the screen can show the result. */
export async function closeTillAction(input: unknown): Promise<FormState & { sessionId?: string }> {
  let sessionId: string | undefined;
  const result = await runAction({ success: "Till closed." }, async (context) => {
    sessionId = (await closeTill(context, input)).id;
  });
  return result.status === "success" ? { ...result, sessionId } : result;
}

/** Saves a manager's or admin's recount of a closed till, as a record of its own. */
export async function recountTillAction(input: unknown): Promise<FormState> {
  return runAction({ success: "Recount saved." }, (context) => recountTill(context, input));
}

/** Asks to put cash into the open till or take cash out (a manager's or admin's own counts at once). */
export async function requestTillCashAction(input: unknown): Promise<FormState & { waiting?: boolean }> {
  let waiting: boolean | undefined;
  const result = await runAction({ success: "Recorded." }, async (context) => {
    waiting = (await requestTillCash(context, input)).status === "WAITING";
  });
  return result.status === "success" ? { ...result, waiting } : result;
}

/** A manager, admin or owner approves or refuses a cash in / cash out request. */
export async function decideTillCashAction(input: { cashRequestId: string; approve: boolean; note: string }): Promise<FormState> {
  return runAction({ success: input.approve ? "Approved." : "Refused." }, (context) => decideTillCash(context, input));
}

/** The person who asked takes a waiting request back. */
export async function withdrawTillCashAction(cashRequestId: string): Promise<FormState> {
  return runAction({ success: "Request taken back." }, (context) => withdrawTillCash(context, { cashRequestId }));
}
