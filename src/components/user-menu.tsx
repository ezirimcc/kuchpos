"use client";

import { forgetKits } from "@/lib/offline/store";
import { ChevronDown, KeyRound, LogOut, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { authClient } from "@/lib/auth-client";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase();
}

/** The person's name at the top right, with a drop-down for Profile, Change password and Sign out. */
export function UserMenu({ name, username, roleLabel }: { name: string; username: string; roleLabel: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function signOut() {
    setSigningOut(true);
    // Signing out also ends selling without internet for this person on this computer (C61).
    // Sales still waiting to be sent are kept.
    await forgetKits().catch(() => undefined);
    await authClient.signOut();
    router.replace("/sign-in");
    router.refresh();
  }

  const item =
    "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted";

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Your account menu"
        className="flex items-center gap-3 rounded-full bg-card py-1.5 pr-3 pl-1.5 text-left transition-colors hover:bg-card/80 dark:border dark:border-border"
      >
        <span className="bg-brand-gradient flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white">
          {initials(name)}
        </span>
        <span className="flex flex-col leading-tight">
          <span className="text-sm font-medium" data-testid="signed-in-as">
            {name}
          </span>
          <span className="text-xs text-muted-foreground" data-testid="role-badge">
            {roleLabel}
          </span>
        </span>
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 w-60 rounded-2xl border bg-popover p-1.5 text-popover-foreground shadow-lg"
        >
          <p className="truncate px-3 pt-2 pb-2.5 text-xs text-muted-foreground">Signed in as {username}</p>
          <Link href="/account" role="menuitem" className={item} onClick={() => setOpen(false)}>
            <UserRound className="size-4 text-muted-foreground" aria-hidden />
            Profile
          </Link>
          <Link href="/account#password" role="menuitem" className={item} onClick={() => setOpen(false)}>
            <KeyRound className="size-4 text-muted-foreground" aria-hidden />
            Change password
          </Link>
          <div className="my-1 h-px bg-border" />
          <button type="button" role="menuitem" onClick={signOut} disabled={signingOut} className={cn(item, "text-destructive")}>
            <LogOut className="size-4" aria-hidden />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
