import type { Metadata } from "next";
import { OfflineCheckout } from "./offline-checkout";

export const metadata: Metadata = { title: "Selling without internet — KuchPos" };

/**
 * The checkout that works with no internet (C60, C61). The page itself carries no data and
 * needs no sign-in: the browser keeps a copy of it and shows that copy whenever the server
 * cannot be reached. Everything on it comes from what this computer kept the last time
 * someone had the checkout open online; without that, it can only say so.
 */
export default function OfflinePage() {
  return (
    <main className="flex flex-1 flex-col gap-4 p-4">
      <OfflineCheckout />
    </main>
  );
}
