"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import type { FormState } from "@/lib/form-state";

/**
 * Deleting a record for good (C67), always in two steps: "Delete…" only opens the question;
 * nothing is deleted until "Yes, delete" is pressed. The server decides whether the record
 * may be deleted at all — this is offered only for records it has said were never used.
 */
export function DeleteForm({
  action,
  fields,
  what,
  size = "sm",
}: {
  action: (previous: FormState, formData: FormData) => Promise<FormState>;
  /** Hidden values sent with the form, such as the record's id. */
  fields: Record<string, string>;
  /** What is being deleted, as it reads in the question: `the product "Hoe"`. */
  what: string;
  size?: "sm" | "default";
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button type="button" variant="outline" size={size} className="text-destructive" onClick={() => setAsking(true)}>
        Delete…
      </Button>
    );
  }
  return (
    <ActionForm action={action} showSuccess={false} compact className="flex max-w-md flex-col gap-2 rounded-2xl border border-destructive/40 p-3 text-left" >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <p className="text-sm whitespace-normal" role="alert">
        Delete {what} for good? This cannot be undone.
      </p>
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="destructive" size="sm" pendingLabel="Deleting…">
          Yes, delete
        </SubmitButton>
        <Button type="button" variant="outline" size="sm" onClick={() => setAsking(false)}>
          No, keep it
        </Button>
      </div>
    </ActionForm>
  );
}
