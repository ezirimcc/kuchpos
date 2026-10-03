"use server";

import type { FormState } from "@/lib/form-state";
import { field, runAction } from "@/server/action";
import { changeOwnPassword, updateOwnProfile } from "@/server/auth/account";

export async function changeOwnPasswordAction(_previous: FormState, formData: FormData): Promise<FormState> {
  if (field(formData, "newPassword") !== field(formData, "repeatPassword")) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: { repeatPassword: "The two new passwords do not match." },
    };
  }
  return runAction({ success: "Your password has been changed." }, (context) =>
    changeOwnPassword(context, {
      currentPassword: field(formData, "currentPassword"),
      newPassword: field(formData, "newPassword"),
    }),
  );
}

export async function updateOwnProfileAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Your details have been saved." }, (context) =>
    updateOwnProfile(context, {
      name: field(formData, "name"),
      username: field(formData, "username"),
      currentPassword: field(formData, "currentPassword"),
    }),
  );
}
