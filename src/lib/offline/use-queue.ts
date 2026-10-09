"use client";

import { liveQuery } from "dexie";
import { useEffect, useState } from "react";
import { offlineDb, type QueueItem } from "./store";

/** Everything in the queue that is not yet safely on the server, oldest first; kept up to date by itself. */
export function useUnsentQueue(): QueueItem[] | null {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  useEffect(() => {
    const watching = liveQuery(() => offlineDb().queue.where("status").anyOf("waiting", "refused").sortBy("seq")).subscribe({
      next: setItems,
      // A browser with its database switched off simply has nothing waiting.
      error: () => setItems([]),
    });
    return () => watching.unsubscribe();
  }, []);
  return items;
}

/** True while the browser reports a network connection. (It can be wrong about the internet beyond it.) */
export function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
