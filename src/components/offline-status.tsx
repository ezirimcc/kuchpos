"use client";

import { CloudOff, CloudUpload, Wifi } from "lucide-react";
import { useEffect, useState } from "react";
import { keepOfflinePage, refreshKit, sendWaiting } from "@/lib/offline/sync";
import { useBrowserOnline, useUnsentQueue } from "@/lib/offline/use-queue";

/** How often, while online, this computer sends what is waiting and renews what it keeps for an outage. */
const RENEW_EVERY_MS = 5 * 60_000;
/** How long after a page opens the first upkeep waits, so the page itself comes first. */
const FIRST_UPKEEP_AFTER_MS = 4000;

/**
 * For people who sell: the always-visible sign of whether this computer is online, offline,
 * or holding sales that have not reached the server yet (PLAN M12) — and, quietly, the
 * upkeep that makes selling without internet possible: every few minutes while online it
 * sends anything waiting, fetches fresh prices and a fresh offline pass, and has the browser
 * keep a current copy of the offline checkout.
 */
export function OfflineStatus() {
  const online = useBrowserOnline();
  const unsent = useUnsentQueue();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let gone = false;
    async function renew() {
      if (!navigator.onLine) return;
      // What is waiting goes first: the fresh kit then reflects it (open tills, offline numbers).
      await sendWaiting();
      const kept = await refreshKit();
      if (!gone) setReady(kept);
      if (kept) await keepOfflinePage();
    }
    // Anything waiting goes at once (it costs nothing when nothing is waiting). The rest of the
    // upkeep — fresh prices, a fresh pass, the kept copy of the offline checkout — waits a few
    // seconds, so that it never competes with the page the person has just asked for: straight
    // after signing in, the small hosting server should be drawing their screen, not this.
    void sendWaiting();
    const first = window.setTimeout(() => {
      // The browser's helper program is only installed on a real (built) site; a development
      // server changes its files too often for a kept copy to make sense.
      if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
        void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(renew, renew);
      } else {
        void renew();
      }
    }, FIRST_UPKEEP_AFTER_MS);
    const timer = window.setInterval(renew, RENEW_EVERY_MS);
    window.addEventListener("online", renew);
    return () => {
      gone = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener("online", renew);
    };
  }, []);

  const waiting = (unsent ?? []).filter((item) => item.status === "waiting").length;
  const refused = (unsent ?? []).length - waiting;
  const pill = "flex h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold";

  if (!online) {
    return (
      <a href="/offline" className={`${pill} bg-amber-400 text-black`} data-testid="connection-status" data-state="offline">
        <CloudOff className="size-4" aria-hidden />
        Offline{waiting > 0 ? ` — ${waiting} waiting to send` : ""}
      </a>
    );
  }
  if (waiting > 0 || refused > 0) {
    return (
      <a href="/offline" className={`${pill} ${refused > 0 ? "bg-destructive text-white" : "bg-amber-400 text-black"}`} data-testid="connection-status" data-state="waiting">
        <CloudUpload className="size-4" aria-hidden />
        {refused > 0
          ? `${refused} not accepted — look`
          : waiting === 1
            ? "1 sale waiting to send"
            : `${waiting} waiting to send`}
      </a>
    );
  }
  return (
    <span
      className={`${pill} bg-card text-muted-foreground dark:border dark:border-border`}
      data-testid="connection-status"
      data-state="online"
      data-offline-ready={ready}
      title={ready ? "This computer is ready to keep selling if the internet drops." : "Online."}
    >
      <Wifi className="size-4 text-emerald-600" aria-hidden />
      Online
    </span>
  );
}
