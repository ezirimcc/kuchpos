"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ADJUSTMENT_REASONS } from "@/lib/adjustment-reasons";
import { signedNumber } from "@/lib/format";
import { adjustFromCountAction } from "../../actions";

type Difference = { lineNumber: number; productName: string; baseUnitName: string; difference: string };

/** Turns the differences of a saved count into one adjustment: a reason for each, then save. */
export function CountAdjustForm({
  countId,
  appliesAtOnce,
  locationName,
  differences,
}: {
  countId: string;
  appliesAtOnce: boolean;
  locationName: string;
  differences: Difference[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [requestId] = useState(() => crypto.randomUUID());
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      const result = await adjustFromCountAction({
        requestId,
        countId,
        note,
        reasons: differences.map((line) => ({ lineNumber: line.lineNumber, reason: reasons[line.lineNumber] ?? "" })),
      });
      if (result.status === "success" && result.adjustmentId) {
        router.push(`/stock/adjustments/${result.adjustmentId}`);
      } else if (result.status === "error") {
        setMessage(result.message);
        setErrors(result.fieldErrors);
      }
    });
  }

  return (
    <Card>
      <CardContent>
        <form onSubmit={save} className="flex flex-col gap-4" data-testid="count-adjust-form">
          <div>
            <h2 className="text-base font-semibold">Correct the stock in {locationName}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Choose why each product did not match.{" "}
              {appliesAtOnce
                ? "Stock changes by these amounts the moment you save."
                : "A manager or admin must approve this before stock changes."}
            </p>
          </div>
          {differences.map((line) => (
            <div key={line.lineNumber} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t pt-3">
              <p className="min-w-56 flex-1">
                <span className="font-medium">{line.productName}</span>{" "}
                <span className="font-semibold text-destructive tabular-nums">
                  {signedNumber(line.difference)} {line.baseUnitName}
                </span>
              </p>
              <div className="flex flex-col gap-1">
                <NativeSelect
                  value={reasons[line.lineNumber] ?? ""}
                  onChange={(event) => setReasons((current) => ({ ...current, [line.lineNumber]: event.target.value }))}
                  aria-label={`Reason for ${line.productName}`}
                  aria-invalid={!!errors[`lines.${line.lineNumber}.reason`]}
                  className="w-64"
                  required
                >
                  <option value="">Choose a reason…</option>
                  {ADJUSTMENT_REASONS.map((reason) => (
                    <option key={reason.value} value={reason.value}>
                      {reason.label}
                    </option>
                  ))}
                </NativeSelect>
                {errors[`lines.${line.lineNumber}.reason`] && (
                  <p className="text-xs text-destructive">{errors[`lines.${line.lineNumber}.reason`]}</p>
                )}
                {errors[`lines.${line.lineNumber}.quantity`] && (
                  <p className="max-w-64 text-xs text-destructive">{errors[`lines.${line.lineNumber}.quantity`]}</p>
                )}
              </div>
            </div>
          ))}
          <div className="flex flex-col gap-1.5 border-t pt-3">
            <Label htmlFor="adjust-note">Note (needed if a reason is &quot;Other&quot;)</Label>
            <Input id="adjust-note" value={note} onChange={(event) => setNote(event.target.value)} aria-invalid={!!errors.note} autoComplete="off" maxLength={300} />
            {errors.note && <p className="text-xs text-destructive">{errors.note}</p>}
          </div>
          {message && <Alert variant="destructive">{message}</Alert>}
          <div>
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Saving…" : appliesAtOnce ? "Adjust stock now" : "Send for approval"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
