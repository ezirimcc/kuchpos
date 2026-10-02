"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/lib/form-state";
import { field, runAction } from "@/server/action";
import {
  closeBusiness,
  createBusiness,
  openBusiness,
  renameBusiness,
  setBusinessActive,
} from "@/server/platform/businesses";

export async function createBusinessAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Business created, with its first admin." }, (context) =>
    createBusiness(context, {
      name: field(formData, "name"),
      adminName: field(formData, "adminName"),
      adminUsername: field(formData, "adminUsername"),
      adminPassword: field(formData, "adminPassword"),
    }),
  );
}

export async function renameBusinessAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Business renamed." }, (context) =>
    renameBusiness(context, { businessId: field(formData, "businessId"), name: field(formData, "name") }),
  );
}

export async function setBusinessActiveAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const active = field(formData, "active") === "true";
  return runAction(
    { success: active ? "Business reactivated." : "Business deactivated." },
    (context) => setBusinessActive(context, { businessId: field(formData, "businessId"), active }),
  );
}

export async function openBusinessAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const result = await runAction({ success: "Business opened." }, (context) =>
    openBusiness(context, { businessId: field(formData, "businessId") }),
  );
  if (result.status === "success") redirect("/");
  return result;
}

export async function closeBusinessAction(): Promise<FormState> {
  const result = await runAction({ success: "Business closed." }, (context) => closeBusiness(context));
  if (result.status === "success") redirect("/owner/businesses");
  return result;
}
