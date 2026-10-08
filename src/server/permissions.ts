import type { Role } from "@/generated/prisma/client";
import { ForbiddenError } from "./errors";

/**
 * The ONE place that says who may do what. It mirrors the permission table in SPEC.md §5.
 * Every server action checks a permission from this list — hiding a button is never the protection.
 *
 * "business" permissions apply inside one business.
 * "platform" permissions are owner-only and apply across businesses.
 */
export const PERMISSIONS = {
  // Staff & settings
  "staff.manage": "business",
  "settings.manage": "business",
  "setup.manage": "business",
  "import.run": "business",
  "activityLog.view": "business",
  // Products & prices
  "product.manage": "business",
  "price.manage": "business",
  "price.view": "business",
  "cost.view": "business",
  // Selling
  "sale.create": "business",
  "payment.take": "business",
  "sale.credit": "business",
  "sale.fromStoreroom": "business",
  "sale.cancel": "business",
  "discount.request": "business",
  "discount.approve": "business",
  "return.request": "business",
  "return.approve": "business",
  "till.operateOwn": "business",
  "till.reviewAny": "business",
  // Customers
  "customer.manage": "business",
  "customer.setCreditLimit": "business",
  "repayment.record": "business",
  "customer.statement.view": "business",
  "customer.balance.view": "business",
  // Stock
  "stock.view": "business",
  "stock.receive": "business",
  "stock.receive.backdate": "business",
  "stock.receipt.correct": "business",
  "stock.receipts.view": "business",
  "supplier.manage": "business",
  "stock.transfer": "business",
  "stock.count": "business",
  "stock.adjust.request": "business",
  "stock.adjust.approve": "business",
  // Reports
  "report.sales.view": "business",
  "report.collections.view": "business",
  "report.ownShift.view": "business",
  "report.stock.view": "business",
  "report.customerDebt.view": "business",
  "report.discounts.view": "business",
  "report.export": "business",
  // Owner only
  "business.manage": "platform",
  "business.open": "platform",
  "owner.manage": "platform",
  "overview.view": "platform",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export type BusinessRole = Exclude<Role, "OWNER">;

export const BUSINESS_ROLES: readonly BusinessRole[] = [
  "ADMIN",
  "MANAGER",
  "ACCOUNTANT",
  "CASHIER",
  "STOREKEEPER",
];

const ROLE_PERMISSIONS: Record<BusinessRole, ReadonlySet<Permission>> = {
  ADMIN: new Set<Permission>(
    (Object.keys(PERMISSIONS) as Permission[]).filter((p) => PERMISSIONS[p] === "business"),
  ),
  MANAGER: new Set<Permission>([
    "activityLog.view",
    "product.manage",
    "price.manage",
    "price.view",
    "cost.view",
    "sale.create",
    "payment.take",
    "sale.credit",
    "sale.fromStoreroom",
    "sale.cancel",
    "discount.request",
    "discount.approve",
    "return.request",
    "return.approve",
    "till.operateOwn",
    "till.reviewAny",
    "customer.manage",
    "customer.setCreditLimit",
    "repayment.record",
    "customer.statement.view",
    "customer.balance.view",
    "stock.view",
    "stock.receive",
    "stock.receive.backdate",
    "stock.receipt.correct",
    "stock.receipts.view",
    "supplier.manage",
    "stock.transfer",
    "stock.count",
    "stock.adjust.request",
    "stock.adjust.approve",
    "report.sales.view",
    "report.collections.view",
    "report.ownShift.view",
    "report.stock.view",
    "report.customerDebt.view",
    "report.discounts.view",
    "report.export",
  ]),
  ACCOUNTANT: new Set<Permission>([
    "activityLog.view",
    "price.view",
    "cost.view",
    "till.reviewAny",
    "customer.manage",
    "repayment.record",
    "customer.statement.view",
    "customer.balance.view",
    "stock.view",
    "stock.receipts.view",
    "report.sales.view",
    "report.collections.view",
    "report.stock.view",
    "report.customerDebt.view",
    "report.discounts.view",
    "report.export",
  ]),
  CASHIER: new Set<Permission>([
    "price.view",
    "sale.create",
    "payment.take",
    "sale.credit",
    "discount.request",
    "return.request",
    "till.operateOwn",
    "customer.manage",
    "repayment.record",
    "customer.balance.view",
    "stock.view",
    "report.ownShift.view",
  ]),
  STOREKEEPER: new Set<Permission>([
    "price.view",
    "stock.view",
    "stock.receive",
    "stock.receipts.view",
    "supplier.manage",
    "stock.transfer",
    "stock.count",
    "stock.adjust.request",
    "report.stock.view",
  ]),
};

/** Does this role hold this permission? Owners hold every permission. */
export function roleHasPermission(role: Role, permission: Permission): boolean {
  if (role === "OWNER") return true;
  if (PERMISSIONS[permission] === "platform") return false;
  return ROLE_PERMISSIONS[role].has(permission);
}

/** The minimum a permission check needs to know about the person asking. */
export type PermissionSubject = {
  actor: { role: Role };
  /** The business in use: a staff member's own business, or the one an owner has opened. */
  business: { id: string } | null;
};

/** True when the person may do this right now (a business permission also needs a business in use). */
export function can(subject: PermissionSubject, permission: Permission): boolean {
  if (!roleHasPermission(subject.actor.role, permission)) return false;
  if (PERMISSIONS[permission] === "business" && !subject.business) return false;
  return true;
}

/** Throws unless the person may do this. Call it first in every server-side operation. */
export function authorize(subject: PermissionSubject, permission: Permission): void {
  if (!roleHasPermission(subject.actor.role, permission)) {
    throw new ForbiddenError();
  }
  if (PERMISSIONS[permission] === "business" && !subject.business) {
    throw new ForbiddenError("Open a business first.");
  }
}

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  ACCOUNTANT: "Accountant",
  CASHIER: "Cashier",
  STOREKEEPER: "Storekeeper",
};
