import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "@/server/auth/context";
import * as activityLog from "@/server/business/activity-log";
import * as adjustments from "@/server/business/adjustments";
import * as approvals from "@/server/business/approvals";
import * as catalog from "@/server/business/catalog";
import * as counts from "@/server/business/counts";
import * as customers from "@/server/business/customers";
import * as dashboard from "@/server/business/dashboard";
import * as paymentMethods from "@/server/business/payment-methods";
import * as sales from "@/server/business/sales";
import * as setup from "@/server/business/setup";
import * as settings from "@/server/business/settings";
import * as staff from "@/server/business/staff";
import * as corrections from "@/server/business/receipt-corrections";
import * as stock from "@/server/business/stock";
import * as suppliers from "@/server/business/suppliers";
import * as till from "@/server/business/till";
import * as transfers from "@/server/business/transfers";
import { getDb } from "@/server/db/client";
import { ForbiddenError, NotFoundError } from "@/server/errors";
import * as businesses from "@/server/platform/businesses";
import * as owners from "@/server/platform/owners";
import * as system from "@/server/platform/system";
import { createUser, createWorld, TEST_PASSWORD, type World } from "../support/world";

/**
 * Calls every server operation directly — no screens involved — as each kind
 * of person, and checks that only the allowed ones get through.
 */

let world: World;
/** A delivery already recorded in each business, for operations that look one up by id. */
let receiptInA = "";
let receiptInB = "";
/** A stock count (2 found where 1 is held) and an adjustment waiting for approval, in each. */
let countInA = "";
let countInB = "";
let waitingInA = "";
let waitingInB = "";

function counted(business: World["a"], quantity = "2") {
  return {
    requestId: randomUUID(),
    locationId: business.shelfId,
    lines: [{ productId: business.product.id, entries: [{ unitId: business.product.baseUnitId, quantity }] }],
  };
}

function adjusting(business: World["a"]) {
  return {
    requestId: randomUUID(),
    locationId: business.shelfId,
    lines: [{ productId: business.product.id, unitId: business.product.baseUnitId, direction: "add", quantity: "1", reason: "FOUND" }],
  };
}

/** A sale by each business's cashier, of stock put on the Shelf for the purpose. */
let saleInA = "";
let saleInB = "";

function selling(business: World["a"]) {
  return {
    requestId: randomUUID(),
    terminalId: business.terminalId,
    expectedTotal: "100.00",
    payments: [{ methodId: business.cashMethodId, amount: "100.00" }],
    lines: [{ productId: business.product.id, unitId: business.product.baseUnitId, quantity: "1", unitPrice: "100.00" }],
  };
}

/** A discount a cashier of each business has sent to be approved. */
let requestInA = "";
let requestInB = "";
function asking(business: World["a"]) {
  return {
    kind: "DISCOUNT" as const,
    saleRequestId: randomUUID(),
    lines: selling(business).lines,
    discount: { amount: "10.00", percent: "10", reason: "Loyal customer" },
  };
}

/** The open till session of each business's terminal (opened by its cashier), and its transfer payment method. */
let tillInA = "";
let tillInB = "";

/** A customer of each business who owes ₦300 from a credit sale. */
let customerInA = "";
let customerInB = "";

/** And a transfer in each. */
let transferInA = "";
let transferInB = "";

function transfer(business: World["a"]) {
  return {
    requestId: randomUUID(),
    fromLocationId: business.storeroomId,
    toLocationId: business.shelfId,
    lines: [{ productId: business.product.id, unitId: business.product.baseUnitId, quantity: "1" }],
  };
}

function delivery(business: World["a"]) {
  return {
    requestId: randomUUID(),
    supplierId: business.supplierId,
    locationId: business.storeroomId,
    lines: [{ productId: business.product.id, unitId: business.product.packUnitId, quantity: "2", unitCost: "700" }],
  };
}

/** A correction of that delivery (3 packs instead of 2), written with business A's own records. */
async function correction(receiptId: string) {
  const receipt = await getDb().goodsReceipt.findUniqueOrThrow({ where: { id: receiptId } });
  return {
    receiptId,
    requestId: randomUUID(),
    expectedVersion: receipt.version,
    reason: "Counted again: one more pack",
    supplierId: world.a.supplierId,
    locationId: world.a.storeroomId,
    receivedOn: receipt.receivedOn.toISOString().slice(0, 10),
    lines: [{ lineNumber: 1, productId: world.a.product.id, unitId: world.a.product.packUnitId, quantity: String(receipt.version + 2), unitCost: "700" }],
  };
}

beforeEach(async () => {
  world = await createWorld();
  receiptInA = (await stock.receiveGoods(world.a.as.ADMIN, delivery(world.a))).id;
  receiptInB = (await stock.receiveGoods(world.b.as.ADMIN, delivery(world.b))).id;
  transferInA = (await transfers.transferStock(world.a.as.ADMIN, transfer(world.a))).id;
  transferInB = (await transfers.transferStock(world.b.as.ADMIN, transfer(world.b))).id;
  for (const business of [world.a, world.b]) {
    await stock.receiveGoods(business.as.ADMIN, { ...delivery(business), locationId: business.shelfId });
  }
  for (const business of [world.a, world.b]) {
    await till.openTill(business.as.CASHIER, { terminalId: business.terminalId, openingFloat: "1000" });
  }
  tillInA = (await getDb().tillSession.findFirstOrThrow({ where: { businessId: world.a.id } })).id;
  tillInB = (await getDb().tillSession.findFirstOrThrow({ where: { businessId: world.b.id } })).id;
  saleInA = (await sales.postSale(world.a.as.CASHIER, selling(world.a))).id;
  saleInB = (await sales.postSale(world.b.as.CASHIER, selling(world.b))).id;
  for (const business of [world.a, world.b]) {
    const { id } = await customers.createCustomer(business.as.ADMIN, { name: "Ada Okafor", phone: "08031234567" });
    await customers.setCreditLimit(business.as.ADMIN, { customerId: id, creditLimit: "100000" });
    await sales.postSale(business.as.ADMIN, {
      requestId: randomUUID(),
      terminalId: business.terminalId,
      expectedTotal: "300.00",
      payments: [],
      customerId: id,
      creditAmount: "300.00",
      lines: [{ productId: business.product.id, unitId: business.product.baseUnitId, quantity: "3", unitPrice: "100.00" }],
    });
    if (business === world.a) customerInA = id;
    else customerInB = id;
  }
  requestInA = (await approvals.requestApproval(world.a.as.CASHIER, asking(world.a))).requestId;
  requestInB = (await approvals.requestApproval(world.b.as.CASHIER, asking(world.b))).requestId;
  countInA = (await counts.submitCount(world.a.as.STOREKEEPER, counted(world.a))).id;
  countInB = (await counts.submitCount(world.b.as.STOREKEEPER, counted(world.b))).id;
  waitingInA = (await adjustments.recordAdjustment(world.a.as.STOREKEEPER, adjusting(world.a))).id;
  waitingInB = (await adjustments.recordAdjustment(world.b.as.STOREKEEPER, adjusting(world.b))).id;
});

type Actor =
  | "ownerOutside"
  | "ownerInA"
  | "ADMIN"
  | "MANAGER"
  | "ACCOUNTANT"
  | "CASHIER"
  | "STOREKEEPER";

const ALL_ACTORS: Actor[] = [
  "ownerOutside",
  "ownerInA",
  "ADMIN",
  "MANAGER",
  "ACCOUNTANT",
  "CASHIER",
  "STOREKEEPER",
];

function contextOf(actor: Actor): AppContext {
  if (actor === "ownerOutside") return world.ownerOutside;
  if (actor === "ownerInA") return world.ownerInA;
  return world.a.as[actor];
}

type Operation = {
  name: string;
  /** Who is allowed. Everyone else must be refused. */
  allowed: Actor[];
  /** Runs the operation with valid input aimed at business A (or at the platform). */
  run: (context: AppContext) => Promise<unknown>;
  /** For operations that take a record id: the same call aimed at business B's record. */
  runAgainstB?: (context: AppContext) => Promise<unknown>;
};

let counter = 0;
const unique = (prefix: string) => `${prefix}${++counter}`;

const BUSINESS_ADMINS: Actor[] = ["ownerInA", "ADMIN"];
const EVERYONE_IN_A: Actor[] = ["ownerInA", "ADMIN", "MANAGER", "ACCOUNTANT", "CASHIER", "STOREKEEPER"];
const PRODUCT_MANAGERS: Actor[] = ["ownerInA", "ADMIN", "MANAGER"];
const RECEIVERS: Actor[] = ["ownerInA", "ADMIN", "MANAGER", "STOREKEEPER"];
const DELIVERY_VIEWERS: Actor[] = ["ownerInA", "ADMIN", "MANAGER", "ACCOUNTANT", "STOREKEEPER"];
const STOCK_MOVERS: Actor[] = ["ownerInA", "ADMIN", "MANAGER", "STOREKEEPER"];
const SELLERS: Actor[] = ["ownerInA", "ADMIN", "MANAGER", "CASHIER"];
const SALES_VIEWERS: Actor[] = ["ownerInA", "ADMIN", "MANAGER", "ACCOUNTANT", "CASHIER"];
const CUSTOMER_KEEPERS: Actor[] = ["ownerInA", "ADMIN", "MANAGER", "ACCOUNTANT", "CASHIER"];
const OWNERS: Actor[] = ["ownerOutside", "ownerInA"];

const OPERATIONS: Operation[] = [
  // --- Staff (SPEC §5: "Create / disable staff accounts, set roles, reset passwords") ---
  {
    name: "staff.listStaff",
    allowed: BUSINESS_ADMINS,
    run: (context) => staff.listStaff(context),
  },
  {
    name: "staff.createStaff",
    allowed: BUSINESS_ADMINS,
    run: (context) =>
      staff.createStaff(context, {
        name: "New Person",
        username: unique("new.person"),
        password: "a-good-password",
        role: "CASHIER",
      }),
  },
  {
    name: "staff.setStaffRole",
    allowed: BUSINESS_ADMINS,
    run: (context) => staff.setStaffRole(context, { userId: world.a.staff.CASHIER.id, role: "MANAGER" }),
    runAgainstB: (context) =>
      staff.setStaffRole(context, { userId: world.b.staff.CASHIER.id, role: "MANAGER" }),
  },
  {
    name: "staff.setStaffDisabled",
    allowed: BUSINESS_ADMINS,
    run: (context) => staff.setStaffDisabled(context, { userId: world.a.staff.STOREKEEPER.id, disabled: true }),
    runAgainstB: (context) =>
      staff.setStaffDisabled(context, { userId: world.b.staff.STOREKEEPER.id, disabled: true }),
  },
  {
    name: "staff.resetStaffPassword",
    allowed: BUSINESS_ADMINS,
    run: (context) =>
      staff.resetStaffPassword(context, { userId: world.a.staff.CASHIER.id, password: "another-password" }),
    runAgainstB: (context) =>
      staff.resetStaffPassword(context, { userId: world.b.staff.CASHIER.id, password: "another-password" }),
  },
  // --- Settings (SPEC §5: "Change business settings") ---
  {
    name: "settings.getBusinessSettings",
    allowed: BUSINESS_ADMINS,
    run: (context) => settings.getBusinessSettings(context),
  },
  {
    name: "settings.setIdleSignOutMinutes",
    allowed: BUSINESS_ADMINS,
    run: (context) => settings.setIdleSignOutMinutes(context, { minutes: "45" }),
  },
  {
    name: "settings.setTaxRate",
    allowed: BUSINESS_ADMINS,
    run: (context) => settings.setTaxRate(context, { ratePercent: "7.5" }),
  },
  {
    name: "settings.setExpiringSoonMonths",
    allowed: BUSINESS_ADMINS,
    run: (context) => settings.setExpiringSoonMonths(context, { months: "6" }),
  },
  // --- Suppliers and receiving goods (SPEC §5: "Stock") ---
  {
    name: "suppliers.listSuppliers",
    allowed: DELIVERY_VIEWERS,
    run: (context) => suppliers.listSuppliers(context),
  },
  {
    name: "suppliers.createSupplier",
    allowed: RECEIVERS,
    run: (context) => suppliers.createSupplier(context, { name: unique("Supplier "), phone: "", note: "" }),
  },
  {
    name: "suppliers.updateSupplier",
    allowed: RECEIVERS,
    run: (context) => suppliers.updateSupplier(context, { supplierId: world.a.supplierId, name: "Renamed Supplier", phone: "0800", note: "" }),
    runAgainstB: (context) =>
      suppliers.updateSupplier(context, { supplierId: world.b.supplierId, name: "Renamed Supplier", phone: "0800", note: "" }),
  },
  {
    name: "suppliers.setSupplierActive",
    allowed: RECEIVERS,
    run: (context) => suppliers.setSupplierActive(context, { supplierId: world.a.supplierId, active: false }),
    runAgainstB: (context) => suppliers.setSupplierActive(context, { supplierId: world.b.supplierId, active: false }),
  },
  {
    name: "stock.getReceivingOptions",
    allowed: RECEIVERS,
    run: (context) => stock.getReceivingOptions(context),
  },
  {
    name: "stock.receiveGoods",
    allowed: RECEIVERS,
    run: (context) => stock.receiveGoods(context, delivery(world.a)),
  },
  {
    name: "stock.listReceipts",
    allowed: DELIVERY_VIEWERS,
    run: (context) => stock.listReceipts(context),
  },
  {
    name: "stock.getReceipt",
    allowed: DELIVERY_VIEWERS,
    run: (context) => stock.getReceipt(context, { receiptId: receiptInA }),
    runAgainstB: (context) => stock.getReceipt(context, { receiptId: receiptInB }),
  },
  {
    name: "corrections.getCorrectionOptions",
    allowed: PRODUCT_MANAGERS,
    run: (context) => corrections.getCorrectionOptions(context, { receiptId: receiptInA }),
    runAgainstB: (context) => corrections.getCorrectionOptions(context, { receiptId: receiptInB }),
  },
  {
    name: "corrections.correctReceipt",
    allowed: PRODUCT_MANAGERS,
    run: async (context) => corrections.correctReceipt(context, await correction(receiptInA)),
    runAgainstB: async (context) => corrections.correctReceipt(context, await correction(receiptInB)),
  },
  {
    name: "corrections.getReceiptHistory",
    allowed: DELIVERY_VIEWERS,
    run: (context) => corrections.getReceiptHistory(context, { receiptId: receiptInA }),
    runAgainstB: (context) => corrections.getReceiptHistory(context, { receiptId: receiptInB }),
  },
  {
    name: "transfers.getTransferOptions",
    allowed: STOCK_MOVERS,
    run: (context) => transfers.getTransferOptions(context),
  },
  {
    name: "transfers.transferStock",
    allowed: STOCK_MOVERS,
    run: (context) => transfers.transferStock(context, transfer(world.a)),
  },
  {
    name: "transfers.listTransfers",
    allowed: DELIVERY_VIEWERS,
    run: (context) => transfers.listTransfers(context),
  },
  {
    name: "transfers.getTransfer",
    allowed: DELIVERY_VIEWERS,
    run: (context) => transfers.getTransfer(context, { transferId: transferInA }),
    runAgainstB: (context) => transfers.getTransfer(context, { transferId: transferInB }),
  },
  {
    name: "counts.getCountSheet",
    allowed: STOCK_MOVERS,
    run: (context) => counts.getCountSheet(context),
  },
  {
    name: "counts.submitCount",
    allowed: STOCK_MOVERS,
    run: (context) => counts.submitCount(context, counted(world.a)),
  },
  {
    name: "counts.listCounts",
    allowed: DELIVERY_VIEWERS,
    run: (context) => counts.listCounts(context),
  },
  {
    name: "counts.getCount",
    allowed: DELIVERY_VIEWERS,
    run: (context) => counts.getCount(context, { countId: countInA }),
    runAgainstB: (context) => counts.getCount(context, { countId: countInB }),
  },
  {
    name: "adjustments.getAdjustmentOptions",
    allowed: STOCK_MOVERS,
    run: (context) => adjustments.getAdjustmentOptions(context),
  },
  {
    name: "adjustments.recordAdjustment",
    allowed: STOCK_MOVERS,
    run: (context) => adjustments.recordAdjustment(context, adjusting(world.a)),
  },
  {
    name: "adjustments.adjustFromCount",
    allowed: STOCK_MOVERS,
    run: async (context) =>
      adjustments.adjustFromCount(context, {
        requestId: randomUUID(),
        // A fresh count each time, because a count can be adjusted only once.
        countId: (await counts.submitCount(world.a.as.ADMIN, counted(world.a, "5"))).id,
        reasons: [{ lineNumber: 1, reason: "FOUND" }],
      }),
    runAgainstB: (context) =>
      adjustments.adjustFromCount(context, { requestId: randomUUID(), countId: countInB, reasons: [{ lineNumber: 1, reason: "FOUND" }] }),
  },
  {
    name: "adjustments.decideAdjustment",
    allowed: PRODUCT_MANAGERS,
    run: (context) => adjustments.decideAdjustment(context, { adjustmentId: waitingInA, outcome: "APPLIED" }),
    runAgainstB: (context) => adjustments.decideAdjustment(context, { adjustmentId: waitingInB, outcome: "APPLIED" }),
  },
  {
    name: "adjustments.listAdjustments",
    allowed: DELIVERY_VIEWERS,
    run: (context) => adjustments.listAdjustments(context),
  },
  {
    name: "adjustments.getAdjustment",
    allowed: DELIVERY_VIEWERS,
    run: (context) => adjustments.getAdjustment(context, { adjustmentId: waitingInA }),
    runAgainstB: (context) => adjustments.getAdjustment(context, { adjustmentId: waitingInB }),
  },
  {
    name: "sales.getCheckoutCatalogue",
    allowed: SELLERS,
    run: (context) => sales.getCheckoutCatalogue(context),
  },
  {
    name: "sales.postSale",
    allowed: SELLERS,
    run: (context) => sales.postSale(context, selling(world.a)),
  },
  {
    name: "sales.listSales",
    allowed: SALES_VIEWERS,
    run: (context) => sales.listSales(context),
  },
  {
    name: "sales.getSale",
    allowed: SALES_VIEWERS,
    run: (context) => sales.getSale(context, { saleId: saleInA }),
    runAgainstB: (context) => sales.getSale(context, { saleId: saleInB }),
  },
  {
    name: "approvals.approveAtScreen",
    allowed: SELLERS,
    run: (context) =>
      approvals.approveAtScreen(context, {
        kind: "DISCOUNT",
        saleRequestId: randomUUID(),
        lines: selling(world.a).lines,
        discount: { amount: "10.00", percent: "10", reason: "Loyal customer" },
        username: "a.manager",
        password: TEST_PASSWORD,
      }),
  },
  {
    name: "approvals.requestApproval",
    allowed: SELLERS,
    run: (context) => approvals.requestApproval(context, asking(world.a)),
  },
  {
    name: "approvals.getApprovalRequest",
    allowed: SELLERS,
    // Only the sender may ask after a request, so each asks after one of their own.
    run: async (context) => approvals.getApprovalRequest(context, { requestId: (await approvals.requestApproval(context, asking(world.a))).requestId }),
    runAgainstB: (context) => approvals.getApprovalRequest(context, { requestId: requestInB }),
  },
  {
    name: "approvals.withdrawApprovalRequest",
    allowed: SELLERS,
    run: async (context) => approvals.withdrawApprovalRequest(context, { requestId: (await approvals.requestApproval(context, asking(world.a))).requestId }),
    runAgainstB: (context) => approvals.withdrawApprovalRequest(context, { requestId: requestInB }),
  },
  {
    name: "approvals.listWaitingApprovals",
    allowed: PRODUCT_MANAGERS,
    run: (context) => approvals.listWaitingApprovals(context),
  },
  {
    name: "approvals.decideApprovalRequest",
    allowed: PRODUCT_MANAGERS,
    run: (context) => approvals.decideApprovalRequest(context, { requestId: requestInA, approve: true }),
    runAgainstB: (context) => approvals.decideApprovalRequest(context, { requestId: requestInB, approve: true }),
  },
  {
    name: "approvals.listApprovals",
    allowed: ["ownerInA", "ADMIN", "MANAGER", "ACCOUNTANT"],
    run: (context) => approvals.listApprovals(context),
  },
  {
    name: "sales.cancelSale",
    allowed: PRODUCT_MANAGERS,
    run: (context) => sales.cancelSale(context, { saleId: saleInA, note: "Customer changed his mind" }),
    runAgainstB: (context) => sales.cancelSale(context, { saleId: saleInB, note: "Customer changed his mind" }),
  },
  {
    name: "sales.recordReceiptPrint",
    allowed: SALES_VIEWERS,
    run: (context) => sales.recordReceiptPrint(context, { saleId: saleInA }),
    runAgainstB: (context) => sales.recordReceiptPrint(context, { saleId: saleInB }),
  },
  {
    name: "paymentMethods.listPaymentMethods",
    allowed: BUSINESS_ADMINS,
    run: (context) => paymentMethods.listPaymentMethods(context),
  },
  {
    name: "paymentMethods.createPaymentMethod",
    allowed: BUSINESS_ADMINS,
    run: (context) => paymentMethods.createPaymentMethod(context, { name: unique("POS machine "), kind: "POS" }),
  },
  {
    name: "paymentMethods.renamePaymentMethod",
    allowed: BUSINESS_ADMINS,
    run: (context) => paymentMethods.renamePaymentMethod(context, { methodId: world.a.transferMethodId, name: unique("Transfer ") }),
    runAgainstB: (context) => paymentMethods.renamePaymentMethod(context, { methodId: world.b.transferMethodId, name: "Renamed" }),
  },
  {
    name: "paymentMethods.setPaymentMethodActive",
    allowed: BUSINESS_ADMINS,
    run: (context) => paymentMethods.setPaymentMethodActive(context, { methodId: world.a.transferMethodId, active: false }),
    runAgainstB: (context) => paymentMethods.setPaymentMethodActive(context, { methodId: world.b.transferMethodId, active: false }),
  },
  {
    name: "till.getTill",
    allowed: SELLERS,
    run: (context) => till.getTill(context, { terminalId: world.a.terminalId }),
  },
  {
    name: "till.openTill",
    allowed: SELLERS,
    // The fixture's till is open, so a second terminal is opened instead.
    run: async (context) =>
      till.openTill(context, {
        terminalId: (await setup.createTerminal(world.a.as.ADMIN, { code: unique("X"), name: "Extra till", paperWidth: "MM80" })).id,
        openingFloat: "0",
      }),
  },
  {
    name: "till.closeTill",
    // The till was opened by the cashier; those who may review any till can close it too.
    allowed: SELLERS,
    run: (context) => till.closeTill(context, { sessionId: tillInA, countedCash: "1100" }),
    runAgainstB: (context) => till.closeTill(context, { sessionId: tillInB, countedCash: "1100" }),
  },
  {
    name: "till.recountTill",
    allowed: PRODUCT_MANAGERS,
    run: async (context) => {
      // A till is recounted after it has been closed.
      await till.closeTill(world.a.as.ADMIN, { sessionId: tillInA, countedCash: "1100" });
      return till.recountTill(context, { sessionId: tillInA, countedCash: "1100", note: "Counted again" });
    },
    runAgainstB: (context) => till.recountTill(context, { sessionId: tillInB, countedCash: "1100", note: "Counted again" }),
  },
  {
    name: "till.listTillSessions",
    allowed: SALES_VIEWERS,
    run: (context) => till.listTillSessions(context),
  },
  {
    name: "till.getTillSession",
    allowed: SALES_VIEWERS,
    run: (context) => till.getTillSession(context, { sessionId: tillInA }),
    runAgainstB: (context) => till.getTillSession(context, { sessionId: tillInB }),
  },
  {
    name: "customers.listCustomers",
    allowed: CUSTOMER_KEEPERS,
    run: (context) => customers.listCustomers(context),
  },
  {
    name: "customers.createCustomer",
    allowed: CUSTOMER_KEEPERS,
    run: (context) => customers.createCustomer(context, { name: "New Customer", phone: `0809${String(1000000 + ++counter)}` }),
  },
  {
    name: "customers.updateCustomer",
    allowed: CUSTOMER_KEEPERS,
    run: (context) => customers.updateCustomer(context, { customerId: customerInA, name: "Ada O.", phone: "08031234567" }),
    runAgainstB: (context) => customers.updateCustomer(context, { customerId: customerInB, name: "Ada O.", phone: "08031234567" }),
  },
  {
    name: "customers.setCustomerActive",
    allowed: CUSTOMER_KEEPERS,
    run: (context) => customers.setCustomerActive(context, { customerId: customerInA, active: false }),
    runAgainstB: (context) => customers.setCustomerActive(context, { customerId: customerInB, active: false }),
  },
  {
    name: "customers.setCreditLimit",
    allowed: PRODUCT_MANAGERS,
    run: (context) => customers.setCreditLimit(context, { customerId: customerInA, creditLimit: "5000" }),
    runAgainstB: (context) => customers.setCreditLimit(context, { customerId: customerInB, creditLimit: "5000" }),
  },
  {
    name: "customers.getCustomer",
    allowed: CUSTOMER_KEEPERS,
    run: (context) => customers.getCustomer(context, { customerId: customerInA }),
    runAgainstB: (context) => customers.getCustomer(context, { customerId: customerInB }),
  },
  {
    name: "customers.getCustomerStatement",
    allowed: ["ownerInA", "ADMIN", "MANAGER", "ACCOUNTANT"],
    run: (context) => customers.getCustomerStatement(context, { customerId: customerInA }),
    runAgainstB: (context) => customers.getCustomerStatement(context, { customerId: customerInB }),
  },
  {
    name: "customers.getRepaymentOptions",
    allowed: CUSTOMER_KEEPERS,
    run: (context) => customers.getRepaymentOptions(context),
  },
  {
    name: "customers.recordRepayment",
    allowed: CUSTOMER_KEEPERS,
    run: (context) =>
      customers.recordRepayment(context, { requestId: randomUUID(), customerId: customerInA, amount: "10", methodId: world.a.transferMethodId }),
    runAgainstB: (context) =>
      customers.recordRepayment(context, { requestId: randomUUID(), customerId: customerInB, amount: "10", methodId: world.a.transferMethodId }),
  },
  {
    name: "stock.listStockOnHand",
    allowed: EVERYONE_IN_A,
    run: (context) => stock.listStockOnHand(context),
  },
  {
    name: "stock.listExpiringSoon",
    allowed: DELIVERY_VIEWERS,
    run: (context) => stock.listExpiringSoon(context),
  },
  {
    name: "settings.setReceiptText",
    allowed: BUSINESS_ADMINS,
    run: (context) => settings.setReceiptText(context, { header: "12 Market Road", footer: "Thank you" }),
  },
  // --- Locations and terminals (SPEC §5: "Create locations and terminals") ---
  {
    name: "setup.getSetup",
    allowed: BUSINESS_ADMINS,
    run: (context) => setup.getSetup(context),
  },
  {
    name: "setup.renameLocation",
    allowed: BUSINESS_ADMINS,
    run: (context) => setup.renameLocation(context, { locationId: world.a.shelfId, name: "Front shelf" }),
    runAgainstB: (context) => setup.renameLocation(context, { locationId: world.b.shelfId, name: "Front shelf" }),
  },
  {
    name: "setup.createTerminal",
    allowed: BUSINESS_ADMINS,
    run: (context) => setup.createTerminal(context, { code: unique("T"), name: "Checkout 2", paperWidth: "MM58" }),
  },
  {
    name: "setup.updateTerminal",
    allowed: BUSINESS_ADMINS,
    run: (context) =>
      setup.updateTerminal(context, { terminalId: world.a.terminalId, name: "Front till", paperWidth: "MM58" }),
    runAgainstB: (context) =>
      setup.updateTerminal(context, { terminalId: world.b.terminalId, name: "Front till", paperWidth: "MM58" }),
  },
  {
    name: "setup.setTerminalActive",
    allowed: BUSINESS_ADMINS,
    run: (context) => setup.setTerminalActive(context, { terminalId: world.a.terminalId, active: false }),
    runAgainstB: (context) => setup.setTerminalActive(context, { terminalId: world.b.terminalId, active: false }),
  },
  // --- Products and prices (SPEC §5: "Products & prices") ---
  {
    name: "dashboard.getDashboard",
    allowed: EVERYONE_IN_A,
    run: (context) => dashboard.getDashboard(context),
  },
  {
    name: "catalog.listProducts",
    allowed: EVERYONE_IN_A,
    run: (context) => catalog.listProducts(context),
  },
  {
    name: "catalog.getProduct",
    allowed: EVERYONE_IN_A,
    run: (context) => catalog.getProduct(context, { productId: world.a.product.id }),
    runAgainstB: (context) => catalog.getProduct(context, { productId: world.b.product.id }),
  },
  {
    name: "catalog.listCategories",
    allowed: EVERYONE_IN_A,
    run: (context) => catalog.listCategories(context),
  },
  {
    name: "catalog.createCategory",
    allowed: PRODUCT_MANAGERS,
    run: (context) => catalog.createCategory(context, { name: unique("Category ") }),
  },
  {
    name: "catalog.renameCategory",
    allowed: PRODUCT_MANAGERS,
    run: (context) => catalog.renameCategory(context, { categoryId: world.a.categoryId, name: "Renamed" }),
    runAgainstB: (context) => catalog.renameCategory(context, { categoryId: world.b.categoryId, name: "Renamed" }),
  },
  {
    name: "catalog.removeCategory",
    allowed: PRODUCT_MANAGERS,
    run: (context) => catalog.removeCategory(context, { categoryId: world.a.emptyCategoryId }),
    runAgainstB: (context) => catalog.removeCategory(context, { categoryId: world.b.emptyCategoryId }),
  },
  {
    name: "catalog.createProduct",
    allowed: PRODUCT_MANAGERS,
    run: (context) =>
      catalog.createProduct(context, {
        name: unique("Product "),
        code: "",
        barcode: "",
        baseUnitName: "single",
        allowsFraction: false,
        taxable: true,
        baseForSale: true,
        basePrice: "250",
      }),
  },
  {
    name: "catalog.updateProduct",
    allowed: PRODUCT_MANAGERS,
    run: (context) =>
      catalog.updateProduct(context, { productId: world.a.product.id, name: "Renamed", code: "", barcode: "", taxable: false }),
    runAgainstB: (context) =>
      catalog.updateProduct(context, { productId: world.b.product.id, name: "Renamed", code: "", barcode: "", taxable: false }),
  },
  {
    name: "catalog.setProductActive",
    allowed: PRODUCT_MANAGERS,
    run: (context) => catalog.setProductActive(context, { productId: world.a.product.id, active: false }),
    runAgainstB: (context) => catalog.setProductActive(context, { productId: world.b.product.id, active: false }),
  },
  {
    name: "catalog.addUnit",
    allowed: PRODUCT_MANAGERS,
    run: (context) =>
      catalog.addUnit(context, {
        productId: world.a.product.id,
        name: "carton",
        factor: "100",
        forSale: true,
        forPurchase: true,
        price: "8500",
      }),
    runAgainstB: (context) =>
      catalog.addUnit(context, {
        productId: world.b.product.id,
        name: "carton",
        factor: "100",
        forSale: true,
        forPurchase: true,
        price: "8500",
      }),
  },
  {
    name: "catalog.setUnitPrice",
    allowed: PRODUCT_MANAGERS,
    run: (context) => catalog.setUnitPrice(context, { unitId: world.a.product.packUnitId, price: "950" }),
    runAgainstB: (context) => catalog.setUnitPrice(context, { unitId: world.b.product.packUnitId, price: "950" }),
  },
  {
    name: "catalog.setUnitUsage",
    allowed: PRODUCT_MANAGERS,
    run: (context) =>
      catalog.setUnitUsage(context, { unitId: world.a.product.packUnitId, forSale: false, forPurchase: true, price: "" }),
    runAgainstB: (context) =>
      catalog.setUnitUsage(context, { unitId: world.b.product.packUnitId, forSale: false, forPurchase: true, price: "" }),
  },
  {
    name: "catalog.retireUnit",
    allowed: PRODUCT_MANAGERS,
    run: (context) => catalog.retireUnit(context, { unitId: world.a.product.packUnitId }),
    runAgainstB: (context) => catalog.retireUnit(context, { unitId: world.b.product.packUnitId }),
  },
  // --- Activity log (SPEC §5: "View activity log") ---
  {
    name: "activityLog.listActivity",
    allowed: ["ownerInA", "ADMIN", "MANAGER", "ACCOUNTANT"],
    run: (context) => activityLog.listActivity(context),
  },
  // --- Owner-only: businesses ---
  {
    name: "businesses.listBusinesses",
    allowed: OWNERS,
    run: (context) => businesses.listBusinesses(context),
  },
  {
    name: "businesses.createBusiness",
    allowed: OWNERS,
    run: (context) =>
      businesses.createBusiness(context, {
        name: unique("Business "),
        adminName: "First Admin",
        adminUsername: unique("first.admin"),
        adminPassword: "a-good-password",
      }),
  },
  {
    name: "businesses.renameBusiness",
    allowed: OWNERS,
    run: (context) => businesses.renameBusiness(context, { businessId: world.b.id, name: unique("Renamed ") }),
  },
  {
    name: "businesses.setBusinessActive",
    allowed: OWNERS,
    run: (context) => businesses.setBusinessActive(context, { businessId: world.b.id, active: false }),
  },
  {
    name: "businesses.openBusiness",
    allowed: OWNERS,
    run: (context) => businesses.openBusiness(context, { businessId: world.b.id }),
  },
  {
    name: "businesses.closeBusiness",
    allowed: OWNERS,
    run: (context) => businesses.closeBusiness(context),
  },
  // --- Owner-only: owners ---
  {
    name: "owners.listOwners",
    allowed: OWNERS,
    run: (context) => owners.listOwners(context),
  },
  {
    name: "owners.createOwner",
    allowed: OWNERS,
    run: (context) =>
      owners.createOwner(context, {
        name: "Second Owner",
        username: unique("second.owner"),
        password: "a-good-password",
      }),
  },
  {
    name: "owners.setOwnerDisabled",
    allowed: OWNERS,
    run: async (context) => {
      const other = await createUser({ username: unique("spare.owner"), role: "OWNER", businessId: null });
      return owners.setOwnerDisabled(context, { userId: other.id, disabled: true });
    },
  },
  {
    name: "owners.resetOwnerPassword",
    allowed: OWNERS,
    run: (context) =>
      owners.resetOwnerPassword(context, { userId: world.owner.id, password: "another-password" }),
  },
  {
    name: "system.getSystemCheck",
    allowed: OWNERS,
    run: (context) => system.getSystemCheck(context, { forwardedFor: null, forwardedProto: null }),
  },
  {
    name: "owners.listPlatformActivity",
    allowed: OWNERS,
    run: (context) => owners.listPlatformActivity(context),
  },
];

describe("every server operation is listed here", () => {
  it("has an access test for each exported operation", () => {
    const exported = [
      ...Object.keys(staff).map((name) => `staff.${name}`),
      ...Object.keys(activityLog).map((name) => `activityLog.${name}`),
      ...Object.keys(settings).map((name) => `settings.${name}`),
      ...Object.keys(catalog).map((name) => `catalog.${name}`),
      ...Object.keys(setup).map((name) => `setup.${name}`),
      ...Object.keys(dashboard).map((name) => `dashboard.${name}`),
      ...Object.keys(stock).map((name) => `stock.${name}`),
      ...Object.keys(corrections).map((name) => `corrections.${name}`),
      ...Object.keys(transfers).map((name) => `transfers.${name}`),
      ...Object.keys(counts).map((name) => `counts.${name}`),
      ...Object.keys(customers).map((name) => `customers.${name}`),
      ...Object.keys(sales).map((name) => `sales.${name}`),
      ...Object.keys(paymentMethods).map((name) => `paymentMethods.${name}`),
      ...Object.keys(till).map((name) => `till.${name}`),
      ...Object.keys(adjustments).map((name) => `adjustments.${name}`),
      ...Object.keys(approvals).map((name) => `approvals.${name}`),
      ...Object.keys(suppliers).map((name) => `suppliers.${name}`),
      ...Object.keys(businesses).map((name) => `businesses.${name}`),
      ...Object.keys(owners).map((name) => `owners.${name}`),
      ...Object.keys(system).map((name) => `system.${name}`),
    ].sort();
    expect(OPERATIONS.map((operation) => operation.name).sort()).toEqual(exported);
  });
});

describe("who may call each operation", () => {
  for (const operation of OPERATIONS) {
    for (const actor of ALL_ACTORS) {
      const allowed = operation.allowed.includes(actor);
      it(`${operation.name} — ${actor} is ${allowed ? "allowed" : "refused"}`, async () => {
        const attempt = operation.run(contextOf(actor));
        if (allowed) {
          await expect(attempt).resolves.not.toThrow();
        } else {
          await expect(attempt).rejects.toBeInstanceOf(ForbiddenError);
        }
      });
    }
  }
});

describe("a refused call changes nothing", () => {
  it("leaves the database untouched when a cashier tries to create staff", async () => {
    const before = await getDb().user.count();
    await expect(
      staff.createStaff(world.a.as.CASHIER, {
        name: "Sneaky",
        username: "sneaky",
        password: "a-good-password",
        role: "ADMIN",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await getDb().user.count()).toBe(before);
  });

  it("leaves the database untouched when an admin tries to create a business", async () => {
    const before = await getDb().business.count();
    await expect(
      businesses.createBusiness(world.a.as.ADMIN, {
        name: "Shadow Business",
        adminName: "X",
        adminUsername: "shadow.admin",
        adminPassword: "a-good-password",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await getDb().business.count()).toBe(before);
  });
});

/** Everything business B owns, to prove a refused call from business A changed none of it. */
async function snapshotOfB() {
  const db = getDb();
  const where = { businessId: world.b.id };
  return {
    users: await db.user.findMany({ where, orderBy: { id: "asc" }, include: { accounts: true } }),
    products: await db.product.findMany({ where, orderBy: { id: "asc" }, include: { units: { orderBy: { id: "asc" } } } }),
    categories: await db.category.findMany({ where, orderBy: { id: "asc" } }),
    suppliers: await db.supplier.findMany({ where, orderBy: { id: "asc" } }),
    balances: await db.stockBalance.findMany({ where, orderBy: { id: "asc" } }),
    movements: await db.stockMovement.count({ where }),
    receipts: await db.goodsReceipt.count({ where }),
    priceChanges: await db.priceChange.count({ where }),
    locations: await db.location.findMany({ where, orderBy: { id: "asc" } }),
    terminals: await db.terminal.findMany({ where, orderBy: { id: "asc" } }),
    business: await db.business.findUnique({ where: { id: world.b.id } }),
  };
}

describe("business A cannot reach business B's records", () => {
  for (const operation of OPERATIONS.filter((op) => op.runAgainstB)) {
    for (const actor of ["ADMIN", "ownerInA"] as Actor[]) {
      it(`${operation.name} — ${actor} of A, using a B record id, gets "not found"`, async () => {
        const before = await snapshotOfB();
        await expect(operation.runAgainstB!(contextOf(actor))).rejects.toBeInstanceOf(NotFoundError);
        expect(await snapshotOfB()).toEqual(before);
      });
    }
  }

  it("lists only A's staff to A's admin", async () => {
    const list = await staff.listStaff(world.a.as.ADMIN);
    expect(list.map((person) => person.username).sort()).toEqual([
      "a.accountant",
      "a.admin",
      "a.cashier",
      "a.manager",
      "a.storekeeper",
    ]);
  });

  it("shows only A's activity to A's admin", async () => {
    await staff.createStaff(world.b.as.ADMIN, {
      name: "B Person",
      username: "b.newperson",
      password: "a-good-password",
      role: "CASHIER",
    });
    const list = (await activityLog.listActivity(world.a.as.ADMIN)).entries;
    expect(list.some((entry) => entry.summary.includes("b.newperson"))).toBe(false);
  });

  it("cannot manage an owner account through the staff operations", async () => {
    await expect(
      staff.setStaffDisabled(world.a.as.ADMIN, { userId: world.owner.id, disabled: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      staff.resetStaffPassword(world.a.as.ADMIN, { userId: world.owner.id, password: "another-password" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cannot create an owner through the staff operations", async () => {
    await expect(
      staff.createStaff(world.a.as.ADMIN, {
        name: "Fake Owner",
        username: "fake.owner",
        password: "a-good-password",
        role: "OWNER",
      }),
    ).rejects.toThrow();
    await expect(
      staff.setStaffRole(world.a.as.ADMIN, { userId: world.a.staff.CASHIER.id, role: "OWNER" }),
    ).rejects.toThrow();
    expect(await getDb().user.count({ where: { role: "OWNER" } })).toBe(1);
  });
});
