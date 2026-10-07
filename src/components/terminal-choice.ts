"use client";

import { useSyncExternalStore } from "react";

/**
 * Which checkout terminal this computer is. Chosen once (on the checkout or the Till page)
 * and remembered in the browser, so every sale and till session from this computer carries
 * the right terminal code.
 */
const TERMINAL_CHOICE = "kuchpos_terminal";

function onStorageChange(callback: () => void) {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

/** The remembered terminal id, or null — also null while the server is drawing the page. */
export function useRememberedTerminal(): string | null {
  return useSyncExternalStore(
    onStorageChange,
    () => window.localStorage.getItem(TERMINAL_CHOICE),
    () => null,
  );
}

export function rememberTerminal(terminalId: string) {
  window.localStorage.setItem(TERMINAL_CHOICE, terminalId);
  // The "storage" event only reaches other tabs; tell this one too.
  window.dispatchEvent(new StorageEvent("storage", { key: TERMINAL_CHOICE }));
}
