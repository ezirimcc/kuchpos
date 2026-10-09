import { keepKit, noteTillOpen, offlineDb, type StoredKit, tidyQueue, waitingItems } from "./store";

/**
 * Sending what was done offline, and fetching a fresh kit. Browser only.
 *
 * Work is sent one piece at a time, in the order it was done. A piece the server saves is
 * marked sent; a piece the server refuses as it stands is marked refused, with the reason,
 * and the rest carries on; anything else (no internet, signed out, server trouble) stops the
 * run with everything left exactly as it was, to be tried again.
 */
export type SendResult = { sent: number; refused: number; stopped: null | "offline" | "signed-out" | "not-allowed" | "trouble" };

let running: Promise<SendResult> | null = null;

/** Sends everything waiting. Calls made while one run is going share that run. */
export function sendWaiting(): Promise<SendResult> {
  running ??= run().finally(() => {
    running = null;
  });
  return running;
}

async function run(): Promise<SendResult> {
  const db = offlineDb();
  const result: SendResult = { sent: 0, refused: 0, stopped: null };
  for (const item of await waitingItems()) {
    let response: Response;
    try {
      response = await fetch("/api/offline/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: item.kind, payload: item.payload }),
        cache: "no-store",
      });
    } catch {
      return { ...result, stopped: "offline" };
    }
    if (response.status === 401) return { ...result, stopped: "signed-out" };
    if (response.status === 403) return { ...result, stopped: "not-allowed" };
    if (response.status === 422) {
      const body = (await response.json().catch(() => ({}))) as { message?: string; fieldErrors?: Record<string, string> };
      // A sale whose till is not open yet is not wrong: it waits, and so does everything after it.
      if (body.fieldErrors?.till) return { ...result, stopped: "trouble" };
      const reasons = Object.values(body.fieldErrors ?? {}).filter((reason) => reason !== "Not accepted.");
      await db.queue.update(item.seq!, { status: "refused", message: [body.message, ...reasons].filter(Boolean).join(" ") || "The server would not accept this." });
      result.refused += 1;
      continue;
    }
    if (!response.ok) return { ...result, stopped: "trouble" };
    const saved = (await response.json()) as { kind: string; receiptNumber?: string };
    const printed = item.receipt?.receiptNumber;
    await db.queue.update(item.seq!, {
      status: "sent",
      sentAt: new Date().toISOString(),
      ...(saved.receiptNumber && printed && saved.receiptNumber !== printed ? { savedAs: saved.receiptNumber } : {}),
    });
    if (item.kind === "till") await noteTillOpen(item.terminalId, true);
    result.sent += 1;
  }
  await tidyQueue();
  return result;
}

/** Asks the server for a fresh kit and keeps it. False when it could not be had (offline, signed out, may not sell). */
export async function refreshKit(): Promise<boolean> {
  try {
    const response = await fetch("/api/offline/kit", { cache: "no-store" });
    if (!response.ok) return false;
    const kit = (await response.json()) as StoredKit;
    await keepKit(kit);
    // The server knows which tills are open; this computer's own notes give way to it.
    // (Except a till opened here whose opening has not been sent yet.)
    const opening = new Set((await waitingItems()).filter((item) => item.kind === "till").map((item) => item.terminalId));
    for (const terminal of kit.catalogue.terminals) {
      if (terminal.tillOpen || !opening.has(terminal.id)) await noteTillOpen(terminal.id, terminal.tillOpen);
    }
    return true;
  } catch {
    return false;
  }
}

/** Asks the service worker to keep a fresh copy of the offline checkout page and its files. */
export async function keepOfflinePage(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  const registration = await navigator.serviceWorker.ready;
  const worker = registration.active;
  if (!worker) return false;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => resolve(false), 60_000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      resolve(!!event.data?.ok);
    };
    worker.postMessage({ type: "keep-offline-page" }, [channel.port2]);
  });
}
