"use client";

import { useRouter } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardContent } from "@/components/ui/card";
import type { FormState } from "@/lib/form-state";
import { createCustomerAction } from "../actions";
import { CustomerFields } from "../customer-fields";

export function NewCustomerForm() {
  const router = useRouter();
  // After saving, go straight to the new customer's page.
  async function create(previous: FormState, formData: FormData) {
    const result = await createCustomerAction(previous, formData);
    if (result.status === "success" && result.customerId) router.push(`/customers/${result.customerId}`);
    return result;
  }
  return (
    <Card>
      <CardContent>
        <ActionForm action={create} showSuccess={false}>
          <CustomerFields />
          <SubmitButton className="mt-2" pendingLabel="Saving…">
            Save customer
          </SubmitButton>
        </ActionForm>
      </CardContent>
    </Card>
  );
}
