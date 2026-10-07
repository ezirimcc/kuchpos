import "server-only";
import { type DocumentKind, Prisma } from "@/generated/prisma/client";
import type { businessDb } from "@/server/db/scoped";

type Tx = Parameters<Parameters<ReturnType<typeof businessDb>["$transaction"]>[0]>[0];

/**
 * Takes the next number for a kind of document (delivery, transfer, count, adjustment) in
 * the business in use. Must be called inside the transaction that saves the document, and
 * FIRST in it: holding the counter makes documents of that kind queue up, so numbers have
 * no gaps — if the transaction fails, the number is given back with everything else.
 *
 * The counters are rows of their own on purpose. They used to be columns of the business
 * record; locking that record for a whole transaction made every sale in the business wait
 * for it and could deadlock with one. Do not put a counter on a record that other work needs.
 */
export async function takeDocumentNumber(tx: Tx, businessId: string, kind: DocumentKind): Promise<number> {
  const bump = () => tx.documentCounter.updateMany({ where: { kind }, data: { next: { increment: 1 } } });

  if ((await bump()).count === 0) {
    // The first document of this kind in this business.
    try {
      await tx.documentCounter.create({ data: { businessId, kind, next: 2 } });
      return 1;
    } catch (error) {
      // Someone else's first document got there at the same moment: take the number after theirs.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      await bump();
    }
  }
  const counter = await tx.documentCounter.findFirstOrThrow({ where: { kind }, select: { next: true } });
  return counter.next - 1;
}
