"use server";

import type { FormState } from "@/lib/form-state";
import { field, runAction } from "@/server/action";
import { createStaff, resetStaffPassword, setStaffDisabled, setStaffRole } from "@/server/business/staff";

export async function createStaffAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Staff account created." }, (context) =>
    createStaff(context, {
      name: field(formData, "name"),
      username: field(formData, "username"),
      password: field(formData, "password"),
      role: field(formData, "role"),
    }),
  );
}

export async function setStaffRoleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Role changed." }, (context) =>
    setStaffRole(context, { userId: field(formData, "userId"), role: field(formData, "role") }),
  );
}

export async function setStaffDisabledAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const disabled = field(formData, "disabled") === "true";
  return runAction(
    { success: disabled ? "Account disabled." : "Account re-enabled." },
    (context) => setStaffDisabled(context, { userId: field(formData, "userId"), disabled }),
  );
}

export async function resetStaffPasswordAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Password changed. The person has been signed out." }, (context) =>
    resetStaffPassword(context, { userId: field(formData, "userId"), password: field(formData, "password") }),
  );
}
