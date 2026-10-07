"use client";

import { Check, X } from "lucide-react";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { decideAdjustmentAction } from "../../actions";

/** Approve (stock changes now) or reject (stock stays as it is; a reason is required). */
export function DecisionForm({ adjustmentId }: { adjustmentId: string }) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);

  function decide(outcome: "APPLIED" | "REJECTED") {
    if (pending) return;
    setMessage(null);
    setNoteError(null);
    startTransition(async () => {
      // On success the page is redrawn by the server and this form is no longer shown.
      const result = await decideAdjustmentAction({ adjustmentId, outcome, note });
      if (result.status === "error") {
        setMessage(result.message);
        setNoteError(result.fieldErrors.note ?? null);
      }
    });
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4" data-testid="decision-form">
        <div>
          <h2 className="text-base font-semibold">Your decision</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Approving changes the stock now. Rejecting leaves the stock as it is, and needs a reason.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="decision-note">Note (required when rejecting)</Label>
          <Input id="decision-note" value={note} onChange={(event) => setNote(event.target.value)} aria-invalid={!!noteError} autoComplete="off" maxLength={300} />
          {noteError && <p className="text-xs text-destructive">{noteError}</p>}
        </div>
        {message && <Alert variant="destructive">{message}</Alert>}
        <div className="flex flex-wrap gap-3">
          <Button type="button" size="lg" disabled={pending} onClick={() => decide("APPLIED")}>
            <Check className="size-4" aria-hidden /> Approve and change stock
          </Button>
          <Button type="button" size="lg" variant="outline" disabled={pending} onClick={() => decide("REJECTED")}>
            <X className="size-4" aria-hidden /> Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
