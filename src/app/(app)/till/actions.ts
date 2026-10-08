"use server";

import type { FormState } from "@/lib/form-state";
import { runAction } from "@/server/action";
import { closeTill, openTill, recountTill } from "@/server/business/till";

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
