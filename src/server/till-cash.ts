import "server-only";
import { Decimal } from "@/lib/decimal";
import type { businessDb } from "@/server/db/scoped";

type Db = ReturnType<typeof businessDb>;
type Reader = Pick<Db, "payment" | "refund" | "repayment" | "tillCashRequest" | "saleReturn">;

/**
 * What moved in and out of a till's drawer during a session, apart from the opening float.
 * The ONE place this is worked out: expected cash at closing, "does the drawer hold enough
 * for this refund / this cash-out", and the session page all use it. Cash handed back for
 * returned goods is part of `refunds`.
 *
 * Not an operation: callers have checked who is asking and pass their business-scoped client
 * (or the transaction they are in).
 */
export async function drawerMovements(
  db: Reader,
  sessionId: string,
): Promise<{ sales: Decimal; repayments: Decimal; refunds: Decimal; cashIn: Decimal; cashOut: Decimal; net: Decimal }> {
  const approved = { tillSessionId: sessionId, decision: { outcome: "APPROVED" as const } };
  const [taken, repaid, refunded, putIn, takenOut] = await Promise.all([
    db.payment.aggregate({ where: { tillSessionId: sessionId, kind: "CASH" }, _sum: { amount: true } }),
    db.repayment.aggregate({ where: { tillSessionId: sessionId, kind: "CASH" }, _sum: { amount: true } }),
    db.refund.aggregate({ where: { tillSessionId: sessionId, kind: "CASH" }, _sum: { amount: true } }),
    db.tillCashRequest.aggregate({ where: { ...approved, direction: "IN" }, _sum: { amount: true } }),
    db.tillCashRequest.aggregate({ where: { ...approved, direction: "OUT" }, _sum: { amount: true } }),
  ]);
  const returned = await db.saleReturn.aggregate({ where: { tillSessionId: sessionId, refundKind: "CASH" }, _sum: { refundPaid: true } });
  const amount = (sum: { _sum: { amount: { toFixed(places: number): string } | null } }) => new Decimal(sum._sum.amount?.toFixed(2) ?? "0");
  const parts = {
    sales: amount(taken),
    repayments: amount(repaid),
    refunds: amount(refunded).plus(returned._sum.refundPaid?.toFixed(2) ?? "0"),
    cashIn: amount(putIn),
    cashOut: amount(takenOut),
  };
  return { ...parts, net: parts.sales.plus(parts.repayments).minus(parts.refunds).plus(parts.cashIn).minus(parts.cashOut) };
}
