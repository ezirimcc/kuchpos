import "server-only";
import type { businessDb } from "@/server/db/scoped";

/**
 * "Has this record ever been used?" — the question behind deleting (C67). A record that was
 * never used may be deleted for good; one that was used can only be taken out of use.
 *
 * These checks are for plain words on the screen. The protection is in the database: every
 * table of stock, sales and money refers to its product, customer, payment method, terminal
 * and supplier with ON DELETE RESTRICT, so a used record cannot be deleted whatever the code does.
 *
 * Not operations: callers have checked who is asking.
 */

type Db = ReturnType<typeof businessDb>;
type Reader = Db | Parameters<Parameters<Db["$transaction"]>[0]>[0];
type AnyTable = { findMany(args: unknown): Promise<Record<string, string | null>[]>; findFirst(args: unknown): Promise<unknown> };
const table = (db: Reader, name: string) => (db as unknown as Record<string, AnyTable>)[name];

/**
 * Every column that records WHO did something, by table (as the database client names it).
 * `tests/unit/usage.test.ts` reads the schema and fails if a new such column is missing here.
 * Sessions and sign-in accounts are not work done; the activity log is looked at separately.
 */
export const USER_COLUMNS: Record<string, string[]> = {
  approval: ["approvedByUserId", "requestedByUserId"],
  approvalRequest: ["requestedByUserId"],
  approvalRequestDecision: ["decidedByUserId"],
  creditLimitChange: ["changedByUserId"],
  customerAccountEntry: ["createdByUserId"],
  goodsReceipt: ["createdByUserId"],
  goodsReceiptVersion: ["createdByUserId"],
  importRun: ["createdByUserId"],
  offlineExceptionReview: ["reviewedByUserId"],
  payment: ["receivedByUserId"],
  priceChange: ["changedByUserId"],
  refund: ["refundedByUserId"],
  paymentCorrection: ["correctedByUserId"],
  repayment: ["receivedByUserId"],
  sale: ["cashierUserId", "sentByUserId"],
  saleCancellation: ["cancelledByUserId"],
  saleReceiptPrint: ["printedByUserId"],
  saleReturn: ["approvedByUserId", "createdByUserId"],
  stockAdjustment: ["createdByUserId"],
  stockAdjustmentDecision: ["decidedByUserId"],
  stockCount: ["createdByUserId"],
  stockMovement: ["userId"],
  stockTransfer: ["createdByUserId"],
  taxRateChange: ["changedByUserId"],
  tillCashDecision: ["decidedByUserId"],
  tillCashRequest: ["requestedByUserId"],
  tillSession: ["openedByUserId"],
  tillSessionClose: ["closedByUserId"],
  tillSessionRecount: ["recountedByUserId"],
};

/**
 * Which of these accounts have done any work: made, approved or received anything, or done
 * anything the activity log records apart from signing in and looking after their own
 * account (password, name).
 */
export async function usersWhoDidSomething(db: Reader, userIds: string[]): Promise<Set<string>> {
  const busy = new Set<string>();
  if (userIds.length === 0) return busy;
  const looks: Promise<void>[] = [];
  for (const [name, columns] of Object.entries(USER_COLUMNS)) {
    for (const column of columns) {
      looks.push(
        table(db, name)
          .findMany({ where: { [column]: { in: userIds } }, distinct: [column], select: { [column]: true } })
          .then((rows) => rows.forEach((row) => row[column] && busy.add(row[column]))),
      );
    }
  }
  looks.push(
    db.activityLog
      .findMany({
        where: { actorUserId: { in: userIds }, NOT: [{ action: { startsWith: "auth." } }, { action: { startsWith: "account." } }] },
        distinct: ["actorUserId"],
        select: { actorUserId: true },
      })
      .then((rows) => rows.forEach((row) => row.actorUserId && busy.add(row.actorUserId))),
  );
  await Promise.all(looks);
  return busy;
}

async function anyRow(db: Reader, tables: string[], where: Record<string, unknown>): Promise<boolean> {
  const found = await Promise.all(tables.map((name) => table(db, name).findFirst({ where, select: { businessId: true } })));
  return found.some((row) => row !== null);
}

/** True once a product has been received, counted, adjusted, transferred, sold or returned. */
export function productWasUsed(db: Reader, productId: string): Promise<boolean> {
  return anyRow(
    db,
    ["stockMovement", "stockBalance", "stockOwed", "stockBatch", "goodsReceiptLine", "goodsReceiptVersionLine", "stockTransferLine", "stockCountLine", "stockAdjustmentLine", "saleLine", "saleReturnLine"],
    { productId },
  );
}

/** True once a unit of a product is named on a delivery, a transfer, an adjustment or a sale. */
export function unitWasUsed(db: Reader, productUnitId: string): Promise<boolean> {
  return anyRow(db, ["goodsReceiptLine", "goodsReceiptVersionLine", "stockTransferLine", "stockAdjustmentLine", "saleLine"], { productUnitId });
}

/** True once a customer has a sale, a line on their account, a repayment or a return. */
export function customerWasUsed(db: Reader, customerId: string): Promise<boolean> {
  return anyRow(db, ["sale", "customerAccountEntry", "repayment", "saleReturn"], { customerId });
}

/** True once a supplier is named on a delivery, or on an earlier version of one. */
export function supplierWasUsed(db: Reader, supplierId: string): Promise<boolean> {
  return anyRow(db, ["goodsReceipt", "goodsReceiptVersion"], { supplierId });
}

/** True once a payment method has taken a payment or a repayment, given a refund, or been named in a payment correction. */
export async function paymentMethodWasUsed(db: Reader, methodId: string): Promise<boolean> {
  return (await anyRow(db, ["payment", "refund", "repayment"], { methodId })) || (await anyRow(db, ["paymentCorrection"], { toMethodId: methodId }));
}

/** True once a checkout terminal has made a sale or had a till opened. */
export function terminalWasUsed(db: Reader, terminalId: string): Promise<boolean> {
  return anyRow(db, ["sale", "tillSession"], { terminalId });
}

/** The ids, out of these, for which `used` says yes. */
export async function usedAmong(ids: string[], used: (id: string) => Promise<boolean>): Promise<Set<string>> {
  const answers = await Promise.all(ids.map(async (id) => [id, await used(id)] as const));
  return new Set(answers.filter(([, yes]) => yes).map(([id]) => id));
}

/** True for the error the database gives when a record that something refers to is deleted. */
export function isStillReferred(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2003";
}
