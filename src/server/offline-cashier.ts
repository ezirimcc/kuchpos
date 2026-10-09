import "server-only";
import { findCashier } from "@/server/auth/approver";
import type { AppContext } from "@/server/auth/context";
import { type OfflinePass, readOfflinePass } from "@/server/auth/offline-pass";
import { businessIdOf } from "@/server/db/scoped";
import { ValidationError } from "@/server/errors";
import { roleHasPermission } from "@/server/permissions";

/** Something about work done offline that a manager should look at (the offline exceptions report). */
export type OfflineNote = { kind: "STOCK_SHORT" | "PRICE_DIFFERENT" | "OUT_OF_USE" | "TIME" | "ACCOUNT" | "RECEIPT_NUMBER"; summary: string };

/**
 * Works out, from the signed offline pass that came with it, who did a piece of work during
 * an outage. Not an operation: the caller has already checked that whoever is SENDING the
 * work is signed in and may sell here.
 *
 * Refused outright if the pass is not genuine or is for another business. A cashier whose
 * account was disabled, or who lost the right to sell, since the pass was signed is still
 * accepted — the goods have left the shop — and that is noted for a manager.
 */
export async function cashierOfPass(
  sender: AppContext,
  token: string,
): Promise<{ asCashier: AppContext; pass: OfflinePass; cashier: { id: string; name: string }; notes: OfflineNote[] }> {
  const businessId = businessIdOf(sender);
  const refuse = (message: string): never => {
    throw new ValidationError(message, { pass: "Not accepted." });
  };
  const pass = readOfflinePass(token);
  if (!pass || pass.businessId !== businessId) return refuse("This cannot be accepted: it does not carry a genuine offline pass for this business.");
  const cashier = await findCashier(pass.userId);
  // Staff belong to one business; an owner belongs to none and may work in any.
  if (!cashier || (cashier.role !== "OWNER" && cashier.businessId !== businessId)) {
    return refuse("This cannot be accepted: the person it names does not belong to this business.");
  }

  const notes: OfflineNote[] = [];
  if (cashier.disabledAt) notes.push({ kind: "ACCOUNT", summary: `${cashier.name}'s account had been disabled when this sale arrived.` });
  else if (!roleHasPermission(cashier.role, "sale.create")) {
    notes.push({ kind: "ACCOUNT", summary: `${cashier.name} was no longer allowed to sell when this sale arrived.` });
  }
  return {
    pass,
    cashier: { id: cashier.id, name: cashier.name },
    notes,
    // Recorded as the person who did it, with the rights of the role the pass was signed for.
    asCashier: {
      actor: { userId: cashier.id, name: cashier.name, username: cashier.username, role: pass.role, sessionId: sender.actor.sessionId },
      business: sender.business,
    },
  };
}
