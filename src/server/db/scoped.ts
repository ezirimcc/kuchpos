import "server-only";
import { getDb } from "./client";

/**
 * The business-scoped database client.
 *
 * Every query made through it is limited to ONE business, so a screen or
 * action cannot forget the filter (CLAUDE.md rule 0). A record that belongs to
 * another business simply looks as if it does not exist.
 *
 * How each table is tied to a business:
 *  - `filter` is added to the `where` of every read, update and delete.
 *  - `stamp` tables get `businessId` written onto every new row.
 *  - Tables without `stamp` cannot be created directly through this client.
 *
 * Limits to keep in mind when writing queries:
 *  - Nested writes (`connect`, nested `create`) are not re-checked. Only connect
 *    to records that were themselves read through this client.
 *  - Raw SQL (`$queryRaw`, `$executeRaw`) bypasses the scope and must not be used here.
 */
type WhereFragment = Record<string, unknown>;

const BUSINESS_SCOPE: Record<string, { filter: (businessId: string) => WhereFragment; stamp: boolean }> = {
  User: { filter: (businessId) => ({ businessId }), stamp: true },
  ActivityLog: { filter: (businessId) => ({ businessId }), stamp: true },
  Session: { filter: (businessId) => ({ user: { businessId } }), stamp: false },
  Account: { filter: (businessId) => ({ user: { businessId } }), stamp: false },
  Business: { filter: (businessId) => ({ id: businessId }), stamp: false },
  Location: { filter: (businessId) => ({ businessId }), stamp: true },
  Terminal: { filter: (businessId) => ({ businessId }), stamp: true },
  Product: { filter: (businessId) => ({ businessId }), stamp: true },
  Category: { filter: (businessId) => ({ businessId }), stamp: true },
  ProductUnit: { filter: (businessId) => ({ businessId }), stamp: true },
  PriceChange: { filter: (businessId) => ({ businessId }), stamp: true },
  TaxRateChange: { filter: (businessId) => ({ businessId }), stamp: true },
  Supplier: { filter: (businessId) => ({ businessId }), stamp: true },
  StockBalance: { filter: (businessId) => ({ businessId }), stamp: true },
  StockMovement: { filter: (businessId) => ({ businessId }), stamp: true },
  GoodsReceipt: { filter: (businessId) => ({ businessId }), stamp: true },
  GoodsReceiptLine: { filter: (businessId) => ({ businessId }), stamp: true },
};

const WHERE_OPERATIONS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
]);

const CREATE_OPERATIONS = new Set(["create", "createMany", "createManyAndReturn"]);

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function stampBusiness(row: Record<string, unknown>, businessId: string): Record<string, unknown> {
  if ("business" in row) {
    throw new Error("Scoped client: set the business by scope, not with a `business` relation.");
  }
  return { ...row, businessId };
}

export function createScopedDb(businessId: string) {
  if (!businessId) {
    throw new Error("Scoped client: a business id is required.");
  }

  return getDb().$extends({
    name: "businessScope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const scope = BUSINESS_SCOPE[model];
          if (!scope) {
            throw new Error(`Scoped client: table "${model}" is not tied to a business.`);
          }
          // Prisma types `args` per operation; here it is handled generically.
          const input = { ...(args as Record<string, unknown>) };

          if (WHERE_OPERATIONS.has(operation)) {
            const where = (input.where ?? {}) as Record<string, unknown>;
            input.where = {
              ...where,
              AND: [...asArray(where.AND as WhereFragment | WhereFragment[] | undefined), scope.filter(businessId)],
            };
            return query(input as typeof args);
          }

          if (CREATE_OPERATIONS.has(operation)) {
            if (!scope.stamp) {
              throw new Error(`Scoped client: "${model}" rows cannot be created directly.`);
            }
            const data = input.data as Record<string, unknown> | Record<string, unknown>[];
            input.data = Array.isArray(data)
              ? data.map((row) => stampBusiness(row, businessId))
              : stampBusiness(data, businessId);
            return query(input as typeof args);
          }

          throw new Error(`Scoped client: "${operation}" is not supported.`);
        },
      },
    },
  });
}

export type ScopedDb = ReturnType<typeof createScopedDb>;

/** The scoped client for the business in use. Throws if there is none (an owner with no business open). */
export function businessDb(subject: { business: { id: string } | null }): ScopedDb {
  if (!subject.business) {
    throw new Error("No business is in use.");
  }
  return createScopedDb(subject.business.id);
}

/**
 * The id of the business in use, for the `businessId` field that new rows must carry.
 * (The scoped client overwrites that field with its own business in any case; this just
 * satisfies the type checker honestly instead of with a placeholder.)
 */
export function businessIdOf(subject: { business: { id: string } | null }): string {
  if (!subject.business) {
    throw new Error("No business is in use.");
  }
  return subject.business.id;
}
