"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { reviewOfflineExceptionAction } from "../actions";

/** Marks one offline exception as looked at, with an optional note on what was done. */
export function ReviewForm({ exceptionId }: { exceptionId: string }) {
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function mark() {
    if (pending) return;
    setProblem(null);
    startTransition(async () => {
      const result = await reviewOfflineExceptionAction({ exceptionId, note });
      if (result.status === "error") setProblem(result.fieldErrors.note ?? result.message);
    });
  }

  return (
    <div className="flex min-w-56 flex-col gap-1.5">
      <div className="flex gap-2">
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What was done (optional)"
          aria-label="What was done (optional)"
          maxLength={300}
          autoComplete="off"
        />
        <Button type="button" size="sm" className="shrink-0" onClick={mark} disabled={pending}>
          {pending ? "Saving…" : "Looked at"}
        </Button>
      </div>
      {problem && <p className="text-xs text-destructive">{problem}</p>}
    </div>
  );
}
