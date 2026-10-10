import "server-only";
import type { businessDb } from "@/server/db/scoped";
import { ValidationError } from "@/server/errors";
import { APPROVAL_MINUTES } from "@/server/sale-lines";

type Tx = Parameters<Parameters<ReturnType<typeof businessDb>["$transaction"]>[0]>[0];

/**
 * Checks that an approval is the right one for what is being saved — same kind, same
 * request, exactly the same thing approved, still in time and not yet used — and hands it
 * back to be spent. Anything else stops the saving. Shared by sales and returns; call it
 * inside the transaction that will write the `approval_use` row.
 */
export async function claimApproval(
  tx: Tx,
  wanted: {
    id: string;
    kind: "DISCOUNT" | "CREDIT_OVER_LIMIT" | "RETURN";
    saleRequestId: string;
    fingerprint: string;
    field: string;
    /** Said when no approval came at all. */
    missing: string;
    /** The headline of the refusal, e.g. "Nothing was sold. Please correct what is marked." */
    nothingSaved: string;
    /** What was changed, in the refusal's words: "sale" or "return". */
    what: string;
  },
): Promise<{ id: string; approvedByUserId: string | null; approvedByName: string }> {
  const refuse = (message: string): never => {
    throw new ValidationError(wanted.nothingSaved, { [wanted.field]: message });
  };
  if (!/^[0-9a-f-]{36}$/i.test(wanted.id)) refuse(wanted.missing || "Ask a manager or admin to approve this.");
  const approval = await tx.approval.findFirst({ where: { id: wanted.id }, include: { use: { select: { id: true } } } });
  if (!approval || approval.kind !== wanted.kind) return refuse("That approval could not be found. Ask for approval again.");
  if (approval.saleRequestId !== wanted.saleRequestId || approval.fingerprint !== wanted.fingerprint) {
    return refuse(`The ${wanted.what} was changed after it was approved, so the approval no longer matches. Ask for approval again.`);
  }
  if (approval.use) return refuse("That approval has already been used. Ask for approval again.");
  if (approval.expiresAt.getTime() <= Date.now()) {
    return refuse(`That approval has run out: it lasts ${APPROVAL_MINUTES} minutes. Ask for approval again.`);
  }
  return { id: approval.id, approvedByUserId: approval.approvedByUserId, approvedByName: approval.approvedByName };
}
