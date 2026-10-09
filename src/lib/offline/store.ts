import { Dexie, type Table } from "dexie";
import type { SaleDetail } from "@/server/business/sales";
import type { OfflineKit } from "@/server/business/offline";

/**
 * What the checkout computer keeps in the browser's own database (IndexedDB) so that it can
 * sell without internet (C60, C61): the latest "kit" from the server, and the queue of work
 * done offline that is waiting to be sent. Nothing here is the truth about stock or money —
 * the server is; this is only what has not reached it yet.
 *
 * Browser only. Never import this from server code.
 */

/** The kit as it is kept: the same as the server hands over, with times as text. */
export type StoredKit = Omit<OfflineKit, "passExpiresAt" | "takenAt"> & { passExpiresAt: string; takenAt: string };

/** What a receipt printed offline shows; the same shape the online receipt is drawn from. */
export type OfflineReceipt = Omit<SaleDetail, "createdAt" | "cancellation"> & { createdAt: string; cancellation: null };

export type QueueItem = {
  /** Position in the queue: work is sent in the order it was done. */
  seq?: number;
  /** The unique ID made on this computer; for a sale, the sale's own. Sending it twice saves it once. */
  id: string;
  kind: "till" | "sale";
  /** Exactly what is sent to the server. */
  payload: Record<string, unknown>;
  madeAt: string;
  cashierName: string;
  terminalId: string;
  /** For a sale: what was printed, so the receipt can be shown and printed again while waiting. */
  receipt?: OfflineReceipt;
  /**
   * waiting: not yet on the server. sent: saved there. refused: the server would not take it
   * as it is and said why — it stays here until someone deals with it.
   */
  status: "waiting" | "sent" | "refused";
  message?: string;
  /** The receipt number the server saved it under, when that differs from the one printed. */
  savedAs?: string;
  sentAt?: string;
};

type Counter = { terminalId: string; next: number };
type Kept = { key: string; value: unknown };

class OfflineDatabase extends Dexie {
  kits!: Table<StoredKit & { userId: string }, string>;
  queue!: Table<QueueItem, number>;
  counters!: Table<Counter, string>;
  kept!: Table<Kept, string>;

  constructor() {
    super("kuchpos-offline");
    this.version(1).stores({
      kits: "userId",
      queue: "++seq, &id, status",
      counters: "terminalId",
      kept: "key",
    });
  }
}

let database: OfflineDatabase | null = null;
export function offlineDb(): OfflineDatabase {
  database ??= new OfflineDatabase();
  return database;
}

const LAST_USER = "last-user";

/** Keeps the kit the server just handed over, and notes whose it is. */
export async function keepKit(kit: StoredKit): Promise<void> {
  const db = offlineDb();
  await db.transaction("rw", db.kits, db.kept, db.counters, async () => {
    await db.kits.put({ ...kit, userId: kit.cashier.userId });
    await db.kept.put({ key: LAST_USER, value: kit.cashier.userId });
    // The server may know of offline numbers this computer has forgotten (cleared browser data).
    for (const terminal of kit.terminals) {
      const counter = await db.counters.get(terminal.id);
      if (!counter || counter.next < terminal.nextOfflineNumber) await db.counters.put({ terminalId: terminal.id, next: terminal.nextOfflineNumber });
    }
  });
}

/** The kit of the person who last had the checkout open online on this computer, if any. */
export async function lastKit(): Promise<StoredKit | null> {
  const db = offlineDb();
  const userId = (await db.kept.get(LAST_USER))?.value;
  if (typeof userId !== "string") return null;
  return (await db.kits.get(userId)) ?? null;
}

/** Signing out ends selling without internet for that person on this computer. Waiting work is kept. */
export async function forgetKits(): Promise<void> {
  const db = offlineDb();
  await db.transaction("rw", db.kits, db.kept, async () => {
    await db.kits.clear();
    await db.kept.delete(LAST_USER);
  });
}

/** Takes the next number of a terminal's offline receipt series. */
export async function takeOfflineNumber(terminalId: string): Promise<number> {
  const db = offlineDb();
  return db.transaction("rw", db.counters, async () => {
    const next = (await db.counters.get(terminalId))?.next ?? 1;
    await db.counters.put({ terminalId, next: next + 1 });
    return next;
  });
}

/** Whether this computer has opened a terminal's till offline (or knows it to be open). */
export async function tillKnownOpen(terminalId: string): Promise<boolean> {
  return (await offlineDb().kept.get(`till-open:${terminalId}`))?.value === true;
}
export async function noteTillOpen(terminalId: string, open: boolean): Promise<void> {
  await offlineDb().kept.put({ key: `till-open:${terminalId}`, value: open });
}

export async function addToQueue(item: QueueItem): Promise<void> {
  await offlineDb().queue.add(item);
}

export async function waitingItems(): Promise<QueueItem[]> {
  return offlineDb().queue.where("status").equals("waiting").sortBy("seq");
}

export async function queueCounts(): Promise<{ waiting: number; refused: number }> {
  const db = offlineDb();
  const [waiting, refused] = await Promise.all([db.queue.where("status").equals("waiting").count(), db.queue.where("status").equals("refused").count()]);
  return { waiting, refused };
}

/** Sent work older than a week is dropped; what is waiting or refused is never dropped. */
export async function tidyQueue(): Promise<void> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await offlineDb()
    .queue.where("status")
    .equals("sent")
    .filter((item) => (item.sentAt ?? item.madeAt) < weekAgo)
    .delete();
}
