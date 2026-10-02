"use server";

import type { FormState } from "@/lib/form-state";
import { field, runAction } from "@/server/action";
import { createOwner, resetOwnerPassword, setOwnerDisabled } from "@/server/platform/owners";

export async function createOwnerAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Owner account created." }, (context) =>
    createOwner(context, {
      name: field(formData, "name"),
      username: field(formData, "username"),
      password: field(formData, "password"),
    }),
  );
}

export async function setOwnerDisabledAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const disabled = field(formData, "disabled") === "true";
  return runAction(
    { success: disabled ? "Owner disabled." : "Owner re-enabled." },
    (context) => setOwnerDisabled(context, { userId: field(formData, "userId"), disabled }),
  );
}

export async function resetOwnerPasswordAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Password changed. That owner has been signed out." }, (context) =>
    resetOwnerPassword(context, { userId: field(formData, "userId"), password: field(formData, "password") }),
  );
}
