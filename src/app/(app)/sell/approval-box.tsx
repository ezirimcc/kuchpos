"use client";

import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Where a manager, admin or owner approves something at the cashier's screen by typing
 * their own username and password. Nobody is signed in or out by this.
 *
 * The password box is deliberately NOT a real password field: a real one makes the browser
 * offer to save the manager's password on the cashier's computer, which would let the
 * cashier approve things alone from then on. The letters are still shown as dots.
 */
export function ApprovalBox({
  what,
  busy,
  error,
  onApprove,
  onCancel,
}: {
  /** What is being approved, in a few words: "a discount of ₦120.00 on ₦1,200.00". */
  what: string;
  busy: boolean;
  error: string | null;
  onApprove: (username: string, password: string) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const filled = username.trim() !== "" && password !== "";

  function approve() {
    if (!filled || busy) return;
    onApprove(username.trim(), password);
    // Never kept on the screen longer than needed.
    setPassword("");
  }
  // The checkout is one big form; Enter here must approve, not complete the sale.
  function onKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    approve();
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-amber-500/50 bg-amber-500/10 p-3" data-testid="approval-box">
      <p className="flex items-start gap-2 text-sm font-medium">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>A manager, admin or owner approves {what} by entering their own username and password here.</span>
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="approver-username">Approver&apos;s username</Label>
        <Input
          id="approver-username"
          name="approver-name-not-saved"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          onKeyDown={onKey}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="approver-password">Approver&apos;s password</Label>
        <Input
          id="approver-password"
          name="approver-secret-not-saved"
          type="text"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={onKey}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          style={{ WebkitTextSecurity: "disc" } as React.CSSProperties}
          aria-invalid={!!error}
        />
        {error && (
          <p className="text-xs text-destructive" data-testid="approval-error">
            {error}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={approve} disabled={!filled || busy}>
          {busy ? "Checking…" : "Approve"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Not now
        </Button>
      </div>
    </div>
  );
}
