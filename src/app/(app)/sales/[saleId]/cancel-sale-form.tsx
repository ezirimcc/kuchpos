"use client";

import { Ban } from "lucide-react";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { nairaFromText } from "@/lib/format";
import { cancelSaleAction } from "../actions";

/**
 * Cancels the whole sale, for an admin or manager, on the day it was made. Kept closed
 * behind a button so it is never pressed by accident.
 */
export function CancelSaleForm({ saleId, refunds }: { saleId: string; refunds: { methodName: string; amount: string }[] }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);

  function cancel(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setNoteError(null);
    startTransition(async () => {
      // On success the page is drawn again by the server and shows the sale as cancelled.
      const result = await cancelSaleAction({ saleId, note });
      if (result.status === "error") {
        setMessage(result.message);
        setNoteError(result.fieldErrors.note ?? null);
      }
    });
  }

  if (!open) {
    return (
      <div>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          <Ban className="size-4" aria-hidden /> Cancel this sale
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <CardContent>
        <form onSubmit={cancel} className="flex max-w-xl flex-col gap-4" data-testid="cancel-sale-form">
          <div>
            <h2 className="text-base font-semibold">Cancel this sale</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              The whole sale is cancelled: the goods go back into stock where they came from, and the customer gets back{" "}
              {refunds.length === 0 ? "nothing (nothing was paid)" : refunds.map((refund) => `${nairaFromText(refund.amount)} (${refund.methodName})`).join(" and ")}
              . Cash comes out of this checkout&apos;s till. The sale stays on record, marked as cancelled. This cannot be undone.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cancel-note">Why is it being cancelled?</Label>
            <Input
              id="cancel-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              aria-invalid={!!noteError}
              placeholder="For example: the customer changed his mind"
              autoComplete="off"
              maxLength={300}
              autoFocus
              required
            />
            {noteError && <p className="text-xs text-destructive">{noteError}</p>}
          </div>
          {message && <Alert variant="destructive">{message}</Alert>}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Cancelling…" : "Cancel the sale and refund"}
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Keep the sale
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
