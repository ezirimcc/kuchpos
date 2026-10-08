"use server";

import type { FormState } from "@/lib/form-state";
import { field, runAction } from "@/server/action";
import { createCustomer, recordRepayment, setCreditLimit, setCustomerActive, updateCustomer } from "@/server/business/customers";

function details(formData: FormData) {
  return {
    name: field(formData, "name"),
    phone: field(formData, "phone"),
    address: field(formData, "address"),
    city: field(formData, "city"),
    state: field(formData, "state"),
  };
}

/** Adds a customer. On success the answer carries the new customer's id so the screen can open or select them. */
export async function createCustomerAction(_previous: FormState, formData: FormData): Promise<FormState & { customerId?: string }> {
  let customerId: string | undefined;
  const result = await runAction({ success: "Customer added." }, async (context) => {
    customerId = (await createCustomer(context, details(formData))).id;
  });
  return result.status === "success" ? { ...result, customerId } : result;
}

/** Adds a customer from inside the checkout, with just a name and a phone number. */
export async function quickCreateCustomerAction(input: { name: string; phone: string }): Promise<FormState & { customerId?: string }> {
  let customerId: string | undefined;
  const result = await runAction({ success: "Customer added." }, async (context) => {
    customerId = (await createCustomer(context, { name: input.name, phone: input.phone })).id;
  });
  return result.status === "success" ? { ...result, customerId } : result;
}

export async function updateCustomerAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Customer saved." }, (context) =>
    updateCustomer(context, { customerId: field(formData, "customerId"), ...details(formData) }),
  );
}

export async function setCustomerActiveAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const active = field(formData, "active") === "true";
  return runAction({ success: active ? "Customer brought back." : "Customer taken out of use." }, (context) =>
    setCustomerActive(context, { customerId: field(formData, "customerId"), active }),
  );
}

export async function setCreditLimitAction(_previous: FormState, formData: FormData): Promise<FormState> {
  return runAction({ success: "Credit limit saved." }, (context) =>
    setCreditLimit(context, { customerId: field(formData, "customerId"), creditLimit: field(formData, "creditLimit") }),
  );
}

/** Records money received against a customer's debt. */
export async function recordRepaymentAction(input: unknown): Promise<FormState> {
  return runAction({ success: "Repayment saved." }, (context) => recordRepayment(context, input));
}
