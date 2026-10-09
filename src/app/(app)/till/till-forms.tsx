"use client";

import { useUnsentQueue } from "@/lib/offline/use-queue";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { rememberTerminal, useRememberedTerminal } from "@/components/terminal-choice";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { CashBreakdown } from "@/lib/cash-notes";
import { closeTillAction, openTillAction, recountTillAction } from "./actions";
import { CashCounter } from "./cash-counter";

type Terminal = { id: string; code: string; name: string };

/**
 * Says which checkout terminal this computer is. With one terminal there is nothing to
 * choose. The choice is remembered on this computer and shared with the checkout screen.
 */
export function TerminalChooser({ terminals, current }: { terminals: Terminal[]; current: string }) {
  const router = useRouter();
  const remembered = useRememberedTerminal();

  // Opened without saying which terminal: use the one this computer remembers.
  useEffect(() => {
    if (current === "" && remembered && terminals.some((terminal) => terminal.id === remembered)) {
      router.replace(`/till?terminal=${remembered}`);
    }
  }, [current, remembered, terminals, router]);

  if (terminals.length < 2) return null;
  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Label htmlFor="terminal">This checkout</Label>
      <NativeSelect
        id="terminal"
        value={current}
        onChange={(event) => {
          rememberTerminal(event.target.value);
          router.replace(`/till?terminal=${event.target.value}`);
        }}
      >
        {current === "" && <option value="">Choose which checkout this computer is…</option>}
        {terminals.map((terminal) => (
          <option key={terminal.id} value={terminal.id}>
            {terminal.code} — {terminal.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

export function OpenTillForm({ terminalId, terminalCode }: { terminalId: string; terminalCode: string }) {
  const [pending, startTransition] = useTransition();
  const [openingFloat, setOpeningFloat] = useState("");
  // The note-by-note count behind the amount, while the amount is still the one it produced.
  const [breakdown, setBreakdown] = useState<CashBreakdown | undefined>();
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function open(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      // On success the page is drawn again by the server and shows the open till.
      const result = await openTillAction({ terminalId, openingFloat: openingFloat.trim(), breakdown });
      if (result.status === "error") {
        setMessage(result.message);
        setErrors(result.fieldErrors);
      }
    });
  }

  return (
    <form onSubmit={open} className="flex max-w-sm flex-col gap-4" data-testid="open-till-form">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="openingFloat">Cash in the drawer now (₦)</Label>
        <Input
          id="openingFloat"
          value={openingFloat}
          onChange={(event) => {
            setOpeningFloat(event.target.value);
            setBreakdown(undefined);
          }}
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={!!errors.openingFloat}
          className="h-12 text-right text-lg tabular-nums"
          autoFocus
          required
        />
        {errors.openingFloat ? (
          <p className="text-xs text-destructive">{errors.openingFloat}</p>
        ) : (
          <p className="text-xs text-muted-foreground">The float you start with for giving change. Type 0 if the drawer is empty.</p>
        )}
      </div>
      <CashCounter
        idPrefix="open"
        onTotal={(amount, counted) => {
          setOpeningFloat(amount);
          setBreakdown(counted);
        }}
      />
      {errors.breakdown && <p className="text-xs text-destructive">{errors.breakdown}</p>}
      {message && <Alert variant="destructive">{message}</Alert>}
      {errors.terminalId && <Alert variant="destructive">{errors.terminalId}</Alert>}
      <div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Opening…" : `Open the till of ${terminalCode}`}
        </Button>
      </div>
    </form>
  );
}

export function CloseTillForm({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [countedCash, setCountedCash] = useState("");
  // The note-by-note count behind the amount, while the amount is still the one it produced.
  const [breakdown, setBreakdown] = useState<CashBreakdown | undefined>();
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Sales made on this computer without internet that have not reached the server yet. The
  // count would be checked without them, so the till must not be closed until they are sent.
  const stillWaiting = (useUnsentQueue() ?? []).length;

  function close(event: React.FormEvent) {
    event.preventDefault();
    if (pending || stillWaiting > 0) return;
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      const result = await closeTillAction({ sessionId, countedCash: countedCash.trim(), breakdown, note });
      if (result.status === "success" && result.sessionId) {
        router.push(`/till/sessions/${result.sessionId}`);
      } else if (result.status === "error") {
        setMessage(result.message);
        setErrors(result.fieldErrors);
      }
    });
  }

  return (
    <form onSubmit={close} className="flex max-w-md flex-col gap-4" data-testid="close-till-form">
      <div>
        <h2 className="text-base font-semibold">Close the till</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Count all the cash in the drawer, including the float, and type the amount. A manager checks it against the
          sales. Nothing can be sold at this checkout until the till is opened again.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="countedCash">Cash counted in the drawer (₦)</Label>
        <Input
          id="countedCash"
          value={countedCash}
          onChange={(event) => {
            setCountedCash(event.target.value);
            setBreakdown(undefined);
          }}
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={!!errors.countedCash}
          className="h-12 text-right text-lg tabular-nums"
          required
        />
        {errors.countedCash && <p className="text-xs text-destructive">{errors.countedCash}</p>}
      </div>
      <CashCounter
        idPrefix="close"
        onTotal={(amount, counted) => {
          setCountedCash(amount);
          setBreakdown(counted);
        }}
      />
      {errors.breakdown && <p className="text-xs text-destructive">{errors.breakdown}</p>}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="closing-note">Note (optional)</Label>
        <Input id="closing-note" value={note} onChange={(event) => setNote(event.target.value)} autoComplete="off" maxLength={300} />
        {errors.note && <p className="text-xs text-destructive">{errors.note}</p>}
      </div>
      {message && <Alert variant="destructive">{message}</Alert>}
      {stillWaiting > 0 && (
        <Alert variant="destructive" data-testid="close-waits-for-offline">
          {stillWaiting === 1 ? "1 sale" : `${stillWaiting} sales or other things`} made on this computer without internet {stillWaiting === 1 ? "has" : "have"} not
          reached the server yet. Wait until the sign at the top says Online with nothing waiting, then close the till.{" "}
          <a href="/offline" className="font-medium underline underline-offset-4">
            See what is waiting
          </a>
        </Alert>
      )}
      <div>
        <Button type="submit" size="lg" variant="outline" disabled={pending || stillWaiting > 0}>
          {pending ? "Closing…" : "Close the till"}
        </Button>
      </div>
    </form>
  );
}

/** A manager's or admin's own count of a closed till, the same day. Saved as a separate record. */
export function RecountTillForm({ sessionId }: { sessionId: string }) {
  const [pending, startTransition] = useTransition();
  const [countedCash, setCountedCash] = useState("");
  // The note-by-note count behind the amount, while the amount is still the one it produced.
  const [breakdown, setBreakdown] = useState<CashBreakdown | undefined>();
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function recount(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setMessage(null);
    setErrors({});
    startTransition(async () => {
      const result = await recountTillAction({ sessionId, countedCash: countedCash.trim(), breakdown, note });
      if (result.status === "success") {
        // The page is drawn again by the server and lists the new recount.
        setCountedCash("");
        setBreakdown(undefined);
        setNote("");
      } else if (result.status === "error") {
        setMessage(result.message);
        setErrors(result.fieldErrors);
      }
    });
  }

  return (
    <form onSubmit={recount} className="flex max-w-md flex-col gap-4" data-testid="recount-till-form">
      <div>
        <h2 className="text-base font-semibold">Count this till again</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Only today, the day it was closed. Your count is saved as a separate record; the closing count stays as it is.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recountedCash">Cash you counted (₦)</Label>
        <Input
          id="recountedCash"
          value={countedCash}
          onChange={(event) => {
            setCountedCash(event.target.value);
            setBreakdown(undefined);
          }}
          inputMode="decimal"
          autoComplete="off"
          aria-invalid={!!errors.countedCash}
          className="text-right tabular-nums"
          required
        />
        {errors.countedCash && <p className="text-xs text-destructive">{errors.countedCash}</p>}
      </div>
      <CashCounter
        idPrefix="recount"
        onTotal={(amount, counted) => {
          setCountedCash(amount);
          setBreakdown(counted);
        }}
      />
      {errors.breakdown && <p className="text-xs text-destructive">{errors.breakdown}</p>}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="recount-note">Why it was counted again</Label>
        <Input id="recount-note" value={note} onChange={(event) => setNote(event.target.value)} aria-invalid={!!errors.note} autoComplete="off" maxLength={300} required />
        {errors.note && <p className="text-xs text-destructive">{errors.note}</p>}
      </div>
      {message && <Alert variant="destructive">{message}</Alert>}
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save recount"}
        </Button>
      </div>
    </form>
  );
}
