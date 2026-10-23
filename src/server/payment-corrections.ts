import "server-only";
import type { PaymentKind, Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import type { businessDb } from "@/server/db/scoped";

/**
 * How a payment was REALLY paid, after any manager's correction (C81).
 *
 * A payment row is never changed. A correction is a row of `payment_correction` beside it;
 * the latest correction of a payment says how it was paid. Everything that shows or adds up
 * payments by method or by kind goes through here:
 *   - `withCorrections` for payments read one by one (sale page and receipt, cancelling a sale,
 *     the sales and collections reports);
 *   - `kindShifts` / `methodShifts` for totals the database adds up (the till's drawer and its
 *     by-method list, "collected today"): each correction moves its amount from the way it was
 *     recorded to the way it was really paid, so a chain of corrections nets out correctly.
 *
 * Not operations: callers have checked who is asking and pass their business-scoped client
 * (or the transaction they are in).
 */

type Db = ReturnType<typeof businessDb>;
type Reader = Pick<Db, "paymentCorrection">;

export type CorrectionView = {
  fromMethodName: string;
  fromKind: PaymentKind;
  toMethodName: string;
  toKind: PaymentKind;
  reason: string;
  correctedByName: string;
  createdAt: Date;
};

type PaymentLike = { id: string; methodId: string; methodName: string; kind: PaymentKind; reference: string | null };

/** The payments as really paid, each with its corrections (oldest first; empty when never corrected). */
export async function withCorrections<T extends PaymentLike>(db: Reader, payments: T[]): Promise<(T & { corrections: CorrectionView[] })[]> {
  if (payments.length === 0) return [];
  const rows = await db.paymentCorrection.findMany({
    where: { paymentId: { in: payments.map((payment) => payment.id) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      paymentId: true,
      fromMethodName: true,
      fromKind: true,
      toMethodId: true,
      toMethodName: true,
      toKind: true,
      toReference: true,
      reason: true,
      correctedByName: true,
      createdAt: true,
    },
  });
  const byPayment = new Map<string, typeof rows>();
  for (const row of rows) byPayment.set(row.paymentId, [...(byPayment.get(row.paymentId) ?? []), row]);
  return payments.map((payment) => {
    const corrections = byPayment.get(payment.id) ?? [];
    const latest = corrections.at(-1);
    return {
      ...payment,
      ...(latest ? { methodId: latest.toMethodId, methodName: latest.toMethodName, kind: latest.toKind, reference: latest.toReference } : {}),
      corrections: corrections.map(({ fromMethodName, fromKind, toMethodName, toKind, reason, correctedByName, createdAt }) => ({
        fromMethodName,
        fromKind,
        toMethodName,
        toKind,
        reason,
        correctedByName,
        createdAt,
      })),
    };
  });
}

const amountOf = (value: { toFixed(places: number): string } | null | undefined) => new Decimal(value?.toFixed(2) ?? "0");

/** By kind, what corrections of the matching payments add (above zero) or take away (below zero). */
export async function kindShifts(db: Reader, where: Prisma.PaymentCorrectionWhereInput): Promise<Map<PaymentKind, Decimal>> {
  const [from, to] = await Promise.all([
    db.paymentCorrection.groupBy({ by: ["fromKind"], where, _sum: { amount: true } }),
    db.paymentCorrection.groupBy({ by: ["toKind"], where, _sum: { amount: true } }),
  ]);
  const shifts = new Map<PaymentKind, Decimal>();
  for (const group of from) shifts.set(group.fromKind, (shifts.get(group.fromKind) ?? new Decimal(0)).minus(amountOf(group._sum.amount)));
  for (const group of to) shifts.set(group.toKind, (shifts.get(group.toKind) ?? new Decimal(0)).plus(amountOf(group._sum.amount)));
  return shifts;
}

/** By way of paying (name and kind), what corrections move: the amount and the number of payments. */
export async function methodShifts(
  db: Reader,
  where: Prisma.PaymentCorrectionWhereInput,
): Promise<Map<string, { methodName: string; kind: PaymentKind; amount: Decimal; count: number }>> {
  const [from, to] = await Promise.all([
    db.paymentCorrection.groupBy({ by: ["fromMethodName", "fromKind"], where, _sum: { amount: true }, _count: { _all: true } }),
    db.paymentCorrection.groupBy({ by: ["toMethodName", "toKind"], where, _sum: { amount: true }, _count: { _all: true } }),
  ]);
  const shifts = new Map<string, { methodName: string; kind: PaymentKind; amount: Decimal; count: number }>();
  const add = (methodName: string, kind: PaymentKind, amount: Decimal, count: number) => {
    const key = `${methodName}|${kind}`;
    const entry = shifts.get(key) ?? { methodName, kind, amount: new Decimal(0), count: 0 };
    shifts.set(key, { ...entry, amount: entry.amount.plus(amount), count: entry.count + count });
  };
  for (const group of from) add(group.fromMethodName, group.fromKind, amountOf(group._sum.amount).negated(), -group._count._all);
  for (const group of to) add(group.toMethodName, group.toKind, amountOf(group._sum.amount), group._count._all);
  return shifts;
}
