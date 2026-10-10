"use server";

import type { FormState } from "@/lib/form-state";
import { runAction } from "@/server/action";
import { postReturn } from "@/server/business/returns";

/** Saves a return sent whole from the return screen. On success the answer carries its id. */
export async function postReturnAction(input: unknown): Promise<FormState & { returnId?: string }> {
  let returnId: string | undefined;
  const result = await runAction({ success: "Return saved." }, async (context) => {
    returnId = (await postReturn(context, input)).id;
  });
  return result.status === "success" ? { ...result, returnId } : result;
}
