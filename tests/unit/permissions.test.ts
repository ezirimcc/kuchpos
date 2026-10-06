import { describe, expect, it } from "vitest";
import type { Role } from "@/generated/prisma/enums";
import {
  BUSINESS_ROLES,
  can,
  PERMISSIONS,
  roleHasPermission,
  type BusinessRole,
  type Permission,
} from "@/server/permissions";

/**
 * The permission table from SPEC.md §5, written out independently of the code.
 * If the code and this table ever disagree, a test fails.
 */
const A: BusinessRole = "ADMIN";
const M: BusinessRole = "MANAGER";
const AC: BusinessRole = "ACCOUNTANT";
const C: BusinessRole = "CASHIER";
const S: BusinessRole = "STOREKEEPER";

const SPEC_TABLE: Array<{ row: string; permission: Permission; allowed: BusinessRole[] }> = [
  // Staff & settings
  { row: "Create / disable staff accounts, set roles, reset passwords", permission: "staff.manage", allowed: [A] },
  { row: "Change business settings (tax rate, receipt text)", permission: "settings.manage", allowed: [A] },
  { row: "Create locations and terminals", permission: "setup.manage", allowed: [A] },
  { row: "Import records from Excel", permission: "import.run", allowed: [A] },
  { row: "View activity log", permission: "activityLog.view", allowed: [A, M, AC] },
  // Products & prices
  { row: "Create / edit products and units", permission: "product.manage", allowed: [A, M] },
  { row: "Change selling prices", permission: "price.manage", allowed: [A, M] },
  { row: "View selling prices", permission: "price.view", allowed: [A, M, AC, C, S] },
  { row: "View cost prices and profit margins", permission: "cost.view", allowed: [A, M, AC] },
  // Selling
  { row: "Make a sale at preset prices", permission: "sale.create", allowed: [A, M, C] },
  { row: "Take cash / card / transfer / split payment", permission: "payment.take", allowed: [A, M, C] },
  { row: "Sell on credit to a customer", permission: "sale.credit", allowed: [A, M, C] },
  { row: "Sell a line directly from the Storeroom (P7)", permission: "sale.fromStoreroom", allowed: [A, M] },
  { row: "Request an extra discount", permission: "discount.request", allowed: [A, M, C] },
  { row: "Approve an extra discount", permission: "discount.approve", allowed: [A, M] },
  { row: "Void a sale / process a return — request", permission: "return.request", allowed: [A, M, C] },
  { row: "Void a sale / process a return — without needing approval", permission: "return.approve", allowed: [A, M] },
  { row: "Open and close own till session", permission: "till.operateOwn", allowed: [A, M, C] },
  { row: "Review any till session", permission: "till.reviewAny", allowed: [A, M, AC] },
  // Customers
  { row: "Create a customer, edit contact details", permission: "customer.manage", allowed: [A, M, AC, C] },
  { row: "Set a customer's credit limit", permission: "customer.setCreditLimit", allowed: [A, M] },
  { row: "Record a debt repayment", permission: "repayment.record", allowed: [A, M, AC, C] },
  { row: "View customer statements", permission: "customer.statement.view", allowed: [A, M, AC] },
  { row: "View customer balances (cashier: balance only)", permission: "customer.balance.view", allowed: [A, M, AC, C] },
  // Stock
  { row: "View stock quantities", permission: "stock.view", allowed: [A, M, AC, C, S] },
  { row: "Receive goods from a supplier", permission: "stock.receive", allowed: [A, M, S] },
  { row: "Add and edit suppliers", permission: "supplier.manage", allowed: [A, M, S] },
  { row: "View deliveries, including their cost prices", permission: "stock.receipts.view", allowed: [A, M, AC, S] },
  { row: "Give a delivery an earlier date (with a note)", permission: "stock.receive.backdate", allowed: [A, M] },
  { row: "Correct a saved delivery (with a reason)", permission: "stock.receipt.correct", allowed: [A, M] },
  { row: "Transfer between Storeroom and Shelf", permission: "stock.transfer", allowed: [A, M, S] },
  { row: "Enter a stock count", permission: "stock.count", allowed: [A, M, S] },
  { row: "Record a stock adjustment (storekeeper: needs approval)", permission: "stock.adjust.request", allowed: [A, M, S] },
  { row: "Approve a stock adjustment", permission: "stock.adjust.approve", allowed: [A, M] },
  // Reports
  { row: "Sales report", permission: "report.sales.view", allowed: [A, M, AC] },
  { row: "Collections report", permission: "report.collections.view", allowed: [A, M, AC] },
  { row: "Sales / collections for own shift only", permission: "report.ownShift.view", allowed: [A, M, C] },
  { row: "Stock on hand / stock movement report", permission: "report.stock.view", allowed: [A, M, AC, S] },
  { row: "Customer debt report", permission: "report.customerDebt.view", allowed: [A, M, AC] },
  { row: "Discounts & approvals report", permission: "report.discounts.view", allowed: [A, M, AC] },
  { row: "Export reports to spreadsheet", permission: "report.export", allowed: [A, M, AC] },
];

const OWNER_ONLY: Permission[] = ["business.manage", "business.open", "owner.manage", "overview.view"];

describe("permission table (SPEC §5)", () => {
  for (const { row, permission, allowed } of SPEC_TABLE) {
    for (const role of BUSINESS_ROLES) {
      const expected = allowed.includes(role);
      it(`${row} — ${role} is ${expected ? "allowed" : "refused"}`, () => {
        expect(roleHasPermission(role, permission)).toBe(expected);
      });
    }
  }

  it("covers every business permission the code defines, and nothing else", () => {
    const inCode = (Object.keys(PERMISSIONS) as Permission[])
      .filter((p) => PERMISSIONS[p] === "business")
      .sort();
    const inTable = SPEC_TABLE.map((entry) => entry.permission).sort();
    expect(inTable).toEqual(inCode);
  });
});

describe("owner-only actions", () => {
  it("lists exactly the platform permissions", () => {
    const inCode = (Object.keys(PERMISSIONS) as Permission[])
      .filter((p) => PERMISSIONS[p] === "platform")
      .sort();
    expect([...OWNER_ONLY].sort()).toEqual(inCode);
  });

  for (const permission of OWNER_ONLY) {
    it(`${permission} is refused for every business role, even admin`, () => {
      for (const role of BUSINESS_ROLES) {
        expect(roleHasPermission(role, permission)).toBe(false);
      }
    });
    it(`${permission} is allowed for an owner`, () => {
      expect(roleHasPermission("OWNER", permission)).toBe(true);
    });
  }
});

describe("owner inside a business", () => {
  const owner = (business: { id: string } | null) => ({ actor: { role: "OWNER" as Role }, business });

  it("can do everything an admin can once a business is open", () => {
    for (const { permission } of SPEC_TABLE) {
      expect(can(owner({ id: "some-business" }), permission)).toBe(true);
    }
  });

  it("cannot do business actions with no business open", () => {
    for (const { permission } of SPEC_TABLE) {
      expect(can(owner(null), permission)).toBe(false);
    }
  });

  it("can do owner-only actions with or without a business open", () => {
    for (const permission of OWNER_ONLY) {
      expect(can(owner(null), permission)).toBe(true);
      expect(can(owner({ id: "some-business" }), permission)).toBe(true);
    }
  });
});
