"use server";

import type { FormState } from "@/lib/form-state";
import { field, runAction } from "@/server/action";
import { setIdleSignOutMinutes } from "@/server/business/settings";

export async function setIdleSignOutAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Automatic sign-out time saved." }, (context) =>
    setIdleSignOutMinutes(context, { minutes: field(formData, "minutes") }),
  );
}
