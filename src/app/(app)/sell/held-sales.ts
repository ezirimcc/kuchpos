"use client";

import { useSyncExternalStore } from "react";

/**
 * Sales put on hold (SPEC C47): kept in this browser, separately for each person, so a
 * cashier can serve someone else and come back. A held sale is not a sale — nothing is
 * saved on the server, no stock is set aside, and prices and stock are checked afresh
 * when it is completed. Keeping them in the browser also means they survive an outage.
 */
export type HeldLine = { productId: string; unitId: string; quantity: string; fromStoreroom: boolean };
export type HeldSale = { id: string; heldAt: string; lines: HeldLine[] };

export const MAX_HELD_SALES = 10;

const keyFor = (userId: string) => `kuchpos_held_sales_${userId}`;
const NONE: HeldSale[] = [];

// The same list object is handed back until the stored text changes (React requires that).
const cache = new Map<string, { raw: string | null; list: HeldSale[] }>();

function read(userId: string): HeldSale[] {
  const raw = window.localStorage.getItem(keyFor(userId));
  const cached = cache.get(userId);
  if (cached && cached.raw === raw) return cached.list;
  let list: HeldSale[] = NONE;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      list = parsed.filter(
        (entry): entry is HeldSale =>
          typeof entry?.id === "string" && typeof entry?.heldAt === "string" && Array.isArray(entry?.lines) && entry.lines.length > 0,
      );
    }
  } catch {
    list = NONE;
  }
  cache.set(userId, { raw, list });
  return list;
}

function write(userId: string, list: HeldSale[]) {
  window.localStorage.setItem(keyFor(userId), JSON.stringify(list));
  // The "storage" event only reaches other tabs; tell this one too.
  window.dispatchEvent(new StorageEvent("storage", { key: keyFor(userId) }));
}

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

/** This person's held sales on this computer, oldest first. Empty while the server draws the page. */
export function useHeldSales(userId: string): HeldSale[] {
  return useSyncExternalStore(
    subscribe,
    () => read(userId),
    () => NONE,
  );
}

/** Puts a sale on hold. Returns false, and holds nothing, if ten are already waiting. */
export function holdSale(userId: string, lines: HeldLine[]): boolean {
  const list = read(userId);
  if (lines.length === 0 || list.length >= MAX_HELD_SALES) return false;
  write(userId, [...list, { id: crypto.randomUUID(), heldAt: new Date().toISOString(), lines }]);
  return true;
}

export function removeHeldSale(userId: string, id: string) {
  write(
    userId,
    read(userId).filter((sale) => sale.id !== id),
  );
}
