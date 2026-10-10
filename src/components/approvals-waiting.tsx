"use client";

import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

/** How often a screen looks for approval requests, in milliseconds. */
export const APPROVALS_POLL_MS = 5000;

/**
 * For people who may approve: a notice in the top bar of every screen whenever a cashier's
 * request is waiting. The screen asks by itself every few seconds; asking does not count as
 * using the screen, so it never puts off the automatic sign-out.
 */
export function ApprovalsWaiting() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let stopped = false;
    async function look() {
      try {
        const response = await fetch("/api/approvals/waiting", { cache: "no-store" });
        // Signed out or no longer allowed: stop asking.
        if (response.status === 401 || response.status === 403) stopped = true;
        if (!response.ok || stopped) return;
        const body = (await response.json()) as { requests: unknown[]; cashRequests?: unknown[] };
        if (!stopped) setCount(body.requests.length + (body.cashRequests?.length ?? 0));
      } catch {
        // No connection just now; try again next time.
      }
    }
    void look();
    const timer = window.setInterval(() => {
      if (stopped) window.clearInterval(timer);
      else void look();
    }, APPROVALS_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  if (count === 0) return null;
  return (
    <Link
      href="/approvals"
      data-testid="approvals-waiting"
      className="flex h-11 items-center gap-2 rounded-full bg-amber-400 px-4 text-sm font-semibold text-black shadow-sm"
    >
      <ShieldAlert className="size-4" aria-hidden />
      {count === 1 ? "1 request is waiting for approval" : `${count} requests are waiting for approval`}
    </Link>
  );
}
