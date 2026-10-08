import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { plainNumber, saleReceiptNumber, shopDayEnd, shopDayStart, shopToday } from "@/lib/format";
import { formatNaira, moneyToString, movingAverageCost, parseMoney, roundMoney, shareDiscount, sumMoney, taxIncludedIn } from "@/lib/money";
import type { PaymentKindValue } from "@/lib/payment-kinds";
import { quantityToString } from "@/lib/quantity";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { optionalText } from "@/server/input";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize, can } from "@/server/permissions";
import { APPROVAL_MINUTES, checkDiscount, checkSaleLines, creditFingerprint, discountFingerprint, saleLinesSchema } from "@/server/sale-lines";

/**
 * Selling, for the business in use.
 *
 * `postSale` is the ONE place a sale is saved. The checkout screen calls it now; offline
 * sync (M12) must call the same function. It receives the whole sale in one message —
 * with the prices and the total the cashier saw — and works everything out again itself:
 * nothing the browser sends about money is trusted, only compared.
 *
 * A sale, its lines, the stock movements, the balances and the payment are saved in one
 * database transaction. Sales are add-only.
 */

const MAX_PAYMENTS = 6;
const MAX_MONEY = new Decimal("99999999999.99");
/** How many times to try again when the database reports that two savers got in each other's way. */
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// What the checkout screen keeps in the browser
// ---------------------------------------------------------------------------

export type CheckoutProduct = {
  id: string;
  name: string;
  code: string | null;
  barcode: string | null;
  allowsFraction: boolean;
  baseUnitName: string;
  /** Units on sale with their preset prices, smallest first. */
  units: { id: string; name: string; factor: string; price: string }[];
  /** Stock in base units when this copy was made — a guide for the cashier; the server decides. */
  onShelf: string;
  inStoreroom: string;
};

export type CheckoutCatalogue = {
  businessName: string;
  /** Tax rate in percent, e.g. "7.50". Prices already include it. */
  taxRatePercent: string;
  /** Checkout terminals in use, and whether each one's till is open (a sale needs an open till). */
  terminals: { id: string; code: string; name: string; tillOpen: boolean }[];
  /** The ways a customer can pay, as the business named them; "Cash" first. */
  paymentMethods: { id: string; name: string; kind: PaymentKindValue }[];
  /** True when this person may take a line from the Storeroom instead of the Shelf. */
  canSellFromStoreroom: boolean;
  /** Customers in use, by name, with what each owes and may owe. Empty means walk-in sales only. */
  customers: { id: string; name: string; phone: string; balance: string; creditLimit: string | null }[];
  /** True when this person may put part of a sale on a customer's account. */
  canSellOnCredit: boolean;
  /** True when this person may let a customer go over their credit limit. */
  canAllowOverLimit: boolean;
  /** True when this person may give an extra discount, and whether they may approve one themselves. */
  canDiscount: boolean;
  canApproveDiscount: boolean;
  products: CheckoutProduct[];
};

export async function getCheckoutCatalogue(context: AppContext): Promise<CheckoutCatalogue> {
  authorize(context, "sale.create");
  const db = businessDb(context);
  const [business, terminals, openTills, paymentMethods, customers, locations, products] = await Promise.all([
    db.business.findFirst({ select: { name: true, taxRatePercent: true } }),
    db.terminal.findMany({ where: { deactivatedAt: null }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    db.tillSession.findMany({ where: { close: null }, select: { terminalId: true } }),
    db.paymentMethod.findMany({
      where: { deactivatedAt: null },
      orderBy: [{ builtIn: "desc" }, { name: "asc" }],
      select: { id: true, name: true, kind: true },
    }),
    db.customer.findMany({
      where: { deactivatedAt: null },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, phone: true, balance: true, creditLimit: true },
    }),
    db.location.findMany({ select: { id: true, kind: true } }),
    db.product.findMany({
      where: { deactivatedAt: null, units: { some: { retiredAt: null, forSale: true, price: { not: null } } } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        code: true,
        barcode: true,
        allowsFraction: true,
        units: { where: { retiredAt: null }, orderBy: { factor: "asc" }, select: { id: true, name: true, factor: true, isBase: true, forSale: true, price: true } },
        stockBalances: { select: { locationId: true, quantity: true } },
      },
    }),
  ]);
  if (!business) throw new NotFoundError("That business could not be found.");
  const kindOf = new Map(locations.map((location) => [location.id, location.kind]));
  const held = (balances: { locationId: string; quantity: Prisma.Decimal }[], kind: "SHELF" | "STOREROOM") =>
    quantityToString(
      balances.filter((balance) => kindOf.get(balance.locationId) === kind).reduce((sum, balance) => sum.plus(balance.quantity.toFixed(3)), new Decimal(0)),
    );

  return {
    businessName: business.name,
    taxRatePercent: business.taxRatePercent.toFixed(2),
    terminals: terminals.map((terminal) => ({
      ...terminal,
      tillOpen: openTills.some((till) => till.terminalId === terminal.id),
    })),
    paymentMethods,
    canSellFromStoreroom: can(context, "sale.fromStoreroom"),
    customers: customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      balance: customer.balance.toFixed(2),
      creditLimit: customer.creditLimit?.toFixed(2) ?? null,
    })),
    canSellOnCredit: can(context, "sale.credit"),
    canAllowOverLimit: can(context, "customer.setCreditLimit"),
    canDiscount: can(context, "discount.request"),
    canApproveDiscount: can(context, "discount.approve"),
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
      barcode: product.barcode,
      allowsFraction: product.allowsFraction,
      baseUnitName: product.units.find((unit) => unit.isBase)?.name ?? "",
      units: product.units
        .filter((unit) => unit.forSale && unit.price !== null)
        .map((unit) => ({ id: unit.id, name: unit.name, factor: unit.factor.toFixed(3), price: unit.price!.toFixed(2) })),
      onShelf: held(product.stockBalances, "SHELF"),
      inStoreroom: held(product.stockBalances, "STOREROOM"),
    })),
  };
}

// ---------------------------------------------------------------------------
// Saving a sale
// ---------------------------------------------------------------------------

const saleSchema = z.object({
  /** The sale's unique ID, made up on the cashier's computer. */
  requestId: z.string().uuid("This sale has expired. Start a new sale."),
  terminalId: z.string().uuid("Choose the checkout terminal."),
  /** The clock of the cashier's computer, if sent. */
  deviceTime: z.string().datetime().optional(),
  /** The total the cashier saw. The server works the total out again and refuses the sale if they differ. */
  expectedTotal: z.string().trim(),
  /**
   * How the sale is paid: one part, or several when it is split. The parts must add up to
   * exactly the total. Cash may carry what was handed over (change is worked out here);
   * a transfer or POS payment may carry a reference.
   */
  payments: z
    .array(
      z.object({
        methodId: z.string().trim(),
        amount: z.string().trim(),
        tendered: z.string().trim().optional().default(""),
        reference: optionalText(60, "The reference is too long (60 characters at most).").optional().default(""),
      }),
    )
    .max(MAX_PAYMENTS, `A sale can be split across at most ${MAX_PAYMENTS} payments.`),
  /** The customer the sale is for. Left out for a walk-in. */
  customerId: z.string().trim().optional().default(""),
  /** The part of the total put on that customer's account instead of being paid now. Empty for none. */
  creditAmount: z.string().trim().optional().default(""),
  /**
   * An extra discount on the whole sale, in Naira; the percentage it was typed as, if it was;
   * why; and, unless the seller may approve discounts themselves, the approval a manager gave.
   */
  discount: z
    .object({
      amount: z.string().trim(),
      percent: z.string().trim().optional().default(""),
      reason: z.string().trim().min(3, "Say why the discount is being given.").max(300, "The reason is too long (300 characters at most)."),
      approvalId: z.string().trim().optional().default(""),
    })
    .optional(),
  /** A manager's approval for taking the customer over their credit limit, if the seller needs one. */
  creditApprovalId: z.string().trim().optional().default(""),
  lines: saleLinesSchema,
});

export type SaleResult = {
  id: string;
  receiptNumber: string;
  total: string;
  /** Cash to hand back to the customer. */
  change: string;
  alreadySaved: boolean;
};

type CheckedPayment = {
  method: { id: string; name: string; kind: PaymentKindValue };
  amount: Decimal;
  tendered: Decimal | null;
  change: Decimal | null;
  reference: string | null;
};

const NOTHING_SOLD = "Nothing was sold. Please correct what is marked.";

type SaleTx = Parameters<Parameters<ReturnType<typeof businessDb>["$transaction"]>[0]>[0];

/**
 * Checks that an approval is the right one for this sale — same kind, same sale, exactly
 * the same thing approved, still in time and not yet used — and hands it back to be spent.
 * Anything else stops the sale.
 */
async function claimApproval(
  tx: SaleTx,
  wanted: { id: string; kind: "DISCOUNT" | "CREDIT_OVER_LIMIT"; saleRequestId: string; fingerprint: string; field: string; missing: string },
): Promise<{ id: string; approvedByName: string }> {
  const refuse = (message: string): never => {
    throw new ValidationError(NOTHING_SOLD, { [wanted.field]: message });
  };
  if (!/^[0-9a-f-]{36}$/i.test(wanted.id)) refuse(wanted.missing || "Ask a manager or admin to approve this.");
  const approval = await tx.approval.findFirst({ where: { id: wanted.id }, include: { use: { select: { id: true } } } });
  if (!approval || approval.kind !== wanted.kind) return refuse("That approval could not be found. Ask for approval again.");
  if (approval.saleRequestId !== wanted.saleRequestId || approval.fingerprint !== wanted.fingerprint) {
    return refuse("The sale was changed after it was approved, so the approval no longer matches. Ask for approval again.");
  }
  if (approval.use) return refuse("That approval has already been used. Ask for approval again.");
  if (approval.expiresAt.getTime() <= Date.now()) {
    return refuse(`That approval has run out: it lasts ${APPROVAL_MINUTES} minutes. Ask for approval again.`);
  }
  return { id: approval.id, approvedByName: approval.approvedByName };
}

/**
 * Saves a sale: the sale, its lines, the stock leaving the Shelf (or Storeroom), and its
 * payment or payments — all of it, or none of it. Sending the same `requestId` again returns the sale
 * that was already saved and changes nothing.
 *
 * Refused when: a price or the total differs from what the server works out; a location
 * does not hold enough; the payments do not add up to exactly the total; cash handed over
 * is less than its part; the terminal's till is not open.
 */
export async function postSale(context: AppContext, input: unknown): Promise<SaleResult> {
  authorize(context, "sale.create");
  authorize(context, "payment.take");
  const businessId = businessIdOf(context);
  const data = parseInput(saleSchema, input);
  const db = businessDb(context);

  const alreadySaved = async (): Promise<SaleResult | null> => {
    const saved = await db.sale.findFirst({
      where: { requestId: data.requestId },
      select: { id: true, receiptNumber: true, total: true, payments: { select: { changeGiven: true } } },
    });
    if (!saved) return null;
    return {
      id: saved.id,
      receiptNumber: saved.receiptNumber,
      total: saved.total.toFixed(2),
      change: moneyToString(sumMoney(saved.payments.map((payment) => new Decimal(payment.changeGiven?.toFixed(2) ?? "0")))),
      alreadySaved: true,
    };
  };
  const repeat = await alreadySaved();
  if (repeat) return repeat;

  const fieldErrors: Record<string, string> = {};

  // --- Terminal, and the lines at the server's own prices ----------------------------
  const terminal = await db.terminal.findFirst({ where: { id: data.terminalId }, select: { id: true, code: true, deactivatedAt: true } });
  if (!terminal) fieldErrors.terminalId = "Choose the checkout terminal.";
  else if (terminal.deactivatedAt) fieldErrors.terminalId = "This checkout terminal is out of use. Choose another.";
  const { checked, locations } = await checkSaleLines(db, context, data.lines, fieldErrors);

  // --- The customer, if the sale is for one -----------------------------------------
  let customer: { id: string; name: string; phone: string } | null = null;
  if (data.customerId) {
    const found = await db.customer.findFirst({
      where: { id: data.customerId },
      select: { id: true, name: true, phone: true, deactivatedAt: true },
    });
    if (!found) fieldErrors.customerId = "Choose the customer again: this one could not be found.";
    else if (found.deactivatedAt) fieldErrors.customerId = `"${found.name}" is out of use. Choose another customer, or sell as a walk-in.`;
    else customer = found;
  }

  // --- The discount, if there is one ---------------------------------------------------
  const subtotal = sumMoney(checked.map((line) => line.lineTotal));
  const linesAreSound = Object.keys(fieldErrors).every((key) => !key.startsWith("lines."));
  let discount = new Decimal(0);
  let discountPercent: Decimal | null = null;
  if (data.discount && linesAreSound) {
    if (!can(context, "discount.request")) {
      fieldErrors["discount.amount"] = "You are not allowed to give a discount.";
    } else {
      const sound = checkDiscount(subtotal, data.discount, fieldErrors);
      discount = sound.discount;
      discountPercent = sound.percent;
    }
  }

  // --- Total and payments ----------------------------------------------------------
  let credit = new Decimal(0);
  const total = subtotal.minus(discount);
  const payments: CheckedPayment[] = [];
  if (linesAreSound) {
    let expected: Decimal | null = null;
    try {
      expected = parseMoney(data.expectedTotal);
    } catch {
      expected = null;
    }
    if (!expected || !expected.equals(total)) {
      fieldErrors.expectedTotal = `The total works out to ${formatNaira(total)}, which is not what this screen showed. Reload the page and enter the sale again.`;
    } else {
      const methods = await db.paymentMethod.findMany({
        where: { id: { in: data.payments.map((payment) => payment.methodId).filter(Boolean) } },
        select: { id: true, name: true, kind: true, deactivatedAt: true },
      });
      const used = new Set<string>();
      data.payments.forEach((payment, index) => {
        const at = (field: string) => `payments.${index}.${field}`;
        const method = methods.find((candidate) => candidate.id === payment.methodId);
        if (!method) {
          fieldErrors[at("methodId")] = "Choose how this is paid.";
          return;
        }
        if (method.deactivatedAt) {
          fieldErrors[at("methodId")] = `"${method.name}" is switched off. Choose another way to pay.`;
          return;
        }
        if (used.has(method.id)) {
          fieldErrors[at("methodId")] = `"${method.name}" is already used in this sale. Put the two amounts together.`;
          return;
        }
        used.add(method.id);

        let amount: Decimal;
        try {
          amount = parseMoney(payment.amount);
          if (!amount.greaterThan(0) || amount.greaterThan(MAX_MONEY)) throw new Error("out of range");
        } catch {
          fieldErrors[at("amount")] = "Enter the amount as a plain number greater than zero, for example 5000 or 5000.50 (no commas).";
          return;
        }

        if (method.kind !== "CASH") {
          // Refused rather than quietly dropped: it would mean the screen and the server disagree.
          if (payment.tendered !== "") {
            fieldErrors[at("tendered")] = "Only cash is handed over with change.";
            return;
          }
          payments.push({ method, amount, tendered: null, change: null, reference: payment.reference || null });
          return;
        }
        if (payment.reference) {
          fieldErrors[at("reference")] = "A cash payment has no reference.";
          return;
        }
        let tendered = amount;
        if (payment.tendered !== "") {
          try {
            tendered = parseMoney(payment.tendered);
            if (tendered.isNegative() || tendered.greaterThan(MAX_MONEY)) throw new Error("out of range");
          } catch {
            fieldErrors[at("tendered")] = "Enter the cash received as a plain amount, for example 5000 or 5000.50 (no commas).";
            return;
          }
        }
        if (tendered.lessThan(amount)) {
          fieldErrors[at("tendered")] = `The cash received is ${formatNaira(amount.minus(tendered))} short of ${formatNaira(amount)}.`;
          return;
        }
        payments.push({ method, amount, tendered, change: tendered.minus(amount), reference: null });
      });

      // Credit: part (or all) of the total goes on the customer's account instead of being paid now.
      if (data.creditAmount !== "") {
        try {
          credit = parseMoney(data.creditAmount);
          if (!credit.greaterThan(0)) throw new Error("out of range");
          if (!can(context, "sale.credit")) fieldErrors.creditAmount = "You are not allowed to sell on credit.";
          else if (!data.customerId) fieldErrors.creditAmount = "Choose the customer first: a walk-in customer cannot buy on credit.";
          else if (credit.greaterThan(total)) fieldErrors.creditAmount = `No more than the total, ${formatNaira(total)}, can go on credit.`;
        } catch {
          fieldErrors.creditAmount = "Enter the amount on credit as a plain number greater than zero, for example 5000 (no commas).";
        }
      }

      const paymentsAreSound = Object.keys(fieldErrors).every((key) => !key.startsWith("payments.") && key !== "creditAmount");
      const paid = sumMoney(payments.map((payment) => payment.amount));
      const toPay = total.minus(credit);
      if (paymentsAreSound && !paid.equals(toPay)) {
        fieldErrors.payments =
          data.payments.length === 0
            ? `Say how the ${formatNaira(toPay)} is paid.`
            : `The payments add up to ${formatNaira(paid)}, but ${formatNaira(toPay)} is to be paid${credit.greaterThan(0) ? ` (the total less ${formatNaira(credit)} on credit)` : ""}. They must be exactly equal.`;
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0 || !terminal) {
    throw new ValidationError(NOTHING_SOLD, fieldErrors);
  }
  const change = sumMoney(payments.map((payment) => payment.change ?? new Decimal(0)));

  // What each product loses from each location, in base units.
  const perPlace = new Map<string, Map<string, Decimal>>();
  for (const line of checked) {
    const places = perPlace.get(line.productId) ?? new Map<string, Decimal>();
    places.set(line.location.id, (places.get(line.location.id) ?? new Decimal(0)).plus(line.baseQuantity));
    perPlace.set(line.productId, places);
  }
  // Always in the same order (product, then location), so two sales cannot block each other.
  const productOrder = [...perPlace.keys()].sort();
  const locationName = new Map(locations.map((location) => [location.id, location.name]));

  const save = () =>
    db.$transaction(
      async (tx) => {
        // The terminal's next number. Taking it also makes sales from one terminal queue up.
        const counter = await tx.terminal.update({
          where: { id: terminal.id },
          data: { nextReceiptNumber: { increment: 1 } },
          select: { nextReceiptNumber: true },
        });
        const sequence = counter.nextReceiptNumber - 1;
        const receiptNumber = saleReceiptNumber(terminal.code, sequence);

        // A sale belongs to the terminal's open till. (Opening and closing take the same
        // "turn" on the terminal, so a till cannot be closed under a sale that is going through.)
        const till = await tx.tillSession.findFirst({ where: { terminalId: terminal.id, close: null }, select: { id: true } });
        if (!till) {
          throw new ValidationError(`Nothing was sold: the till of ${terminal.code} is not open. Open the till, then complete the sale.`, {
            till: "The till is not open.",
          });
        }

        // Approvals. Whoever may approve such things themselves needs none; anyone else must
        // bring one a manager gave for exactly this sale, and it is spent here, once.
        const spent: string[] = [];
        const own: { kind: "DISCOUNT" | "CREDIT_OVER_LIMIT"; fingerprint: string; amount: Decimal; basis: Decimal; reason: string | null }[] = [];
        if (discount.greaterThan(0)) {
          const print = discountFingerprint(data.requestId, checked, discount);
          if (can(context, "discount.approve")) {
            own.push({ kind: "DISCOUNT", fingerprint: print, amount: discount, basis: subtotal, reason: data.discount?.reason ?? null });
          } else {
            const approval = await claimApproval(tx, {
              id: data.discount?.approvalId ?? "",
              kind: "DISCOUNT",
              saleRequestId: data.requestId,
              fingerprint: print,
              field: "discount.approvalId",
              missing: "A manager or admin must approve this discount before the sale can be completed.",
            });
            spent.push(approval.id);
          }
        }

        // Credit: the customer's "turn" comes before any product's. Their balance goes up in one
        // statement, and the limit is checked against the balance that statement left.
        let owedAfter: Decimal | null = null;
        let overLimit = false;
        let overLimitAllowedBy = context.actor.name;
        if (customer && credit.greaterThan(0)) {
          const account = await tx.customer.update({
            where: { id: customer.id },
            data: { balance: { increment: moneyToString(credit) } },
            select: { balance: true, creditLimit: true },
          });
          owedAfter = new Decimal(account.balance.toFixed(2));
          const owedBefore = owedAfter.minus(credit);
          if (account.creditLimit === null) {
            throw new ValidationError(NOTHING_SOLD, {
              creditAmount: `${customer.name} cannot buy on credit yet. An admin or manager must first give them a credit limit.`,
            });
          }
          const limit = new Decimal(account.creditLimit.toFixed(2));
          if (owedAfter.greaterThan(limit)) {
            const print = creditFingerprint(data.requestId, customer.id, credit);
            if (can(context, "customer.setCreditLimit")) {
              own.push({ kind: "CREDIT_OVER_LIMIT", fingerprint: print, amount: credit, basis: owedAfter, reason: null });
            } else if (data.creditApprovalId) {
              const approval = await claimApproval(tx, {
                id: data.creditApprovalId,
                kind: "CREDIT_OVER_LIMIT",
                saleRequestId: data.requestId,
                fingerprint: print,
                field: "creditAmount",
                missing: "",
              });
              spent.push(approval.id);
              overLimitAllowedBy = approval.approvedByName;
            } else {
              const room = Decimal.max(limit.minus(owedBefore), 0);
              throw new ValidationError(NOTHING_SOLD, {
                creditAmount:
                  `${customer.name} owes ${formatNaira(owedBefore)} and their limit is ${formatNaira(limit)}, so only ` +
                  `${formatNaira(room)} more can go on credit. A manager or admin can allow more, or raise the limit.`,
              });
            }
            overLimit = true;
          }
        }

        // The tax rate at this moment; it is copied onto the sale and never looked up again.
        const business = await tx.business.findFirst({ select: { taxRatePercent: true } });
        const rate = new Decimal(business?.taxRatePercent.toFixed(2) ?? "0");

        const short: Record<string, string> = {};
        const costOf = new Map<string, Decimal>();
        for (const productId of productOrder) {
          // The product's "turn", as for every other stock change; its average cost is read here.
          const product = await tx.product.update({
            where: { id: productId },
            data: { updatedAt: new Date() },
            select: { averageCost: true },
          });
          costOf.set(productId, new Decimal(product.averageCost.toFixed(4)));

          const places = [...perPlace.get(productId)!.entries()].sort(([a], [b]) => a.localeCompare(b));
          for (const [locationId, quantity] of places) {
            // Taken out only if that much is there — one statement, so two cashiers can never
            // both sell the last one.
            const needed = quantityToString(quantity);
            const lowered = await tx.stockBalance.updateMany({
              where: { productId, locationId, quantity: { gte: needed } },
              data: { quantity: { decrement: needed } },
            });
            if (lowered.count === 1) continue;
            const there = await tx.stockBalance.findFirst({ where: { productId, locationId }, select: { quantity: true } });
            for (const line of checked) {
              if (line.productId !== productId || line.location.id !== locationId) continue;
              short[`lines.${line.index}.quantity`] =
                `Only ${plainNumber(there?.quantity.toFixed(3) ?? "0")} ${line.baseUnitName} of "${line.productName}" is in ` +
                `${locationName.get(locationId)}. This sale needs ${plainNumber(needed)} ${line.baseUnitName}.`;
            }
          }
        }
        // Throwing here undoes everything above, including the products that had enough.
        if (Object.keys(short).length > 0) {
          throw new ValidationError("Nothing was sold: there is not enough stock.", short);
        }

        // The discount is shared out over the lines, so each line knows what was really charged for it.
        const shares = shareDiscount(
          checked.map((line) => line.lineTotal),
          discount,
        );
        const lines = checked.map((line, position) => {
          const lineRate = line.taxable ? rate : new Decimal(0);
          const baseUnitCost = costOf.get(line.productId)!;
          return {
            line,
            lineNumber: position + 1,
            discountAmount: shares[position],
            taxRatePercent: lineRate,
            // Tax is what is inside the amount actually charged.
            taxAmount: taxIncludedIn(line.lineTotal.minus(shares[position]), lineRate),
            baseUnitCost,
            lineCost: roundMoney(line.baseQuantity.times(baseUnitCost)),
          };
        });

        const sale = await tx.sale.create({
          data: {
            businessId,
            requestId: data.requestId,
            terminalId: terminal.id,
            terminalCode: terminal.code,
            sequence,
            receiptNumber,
            total: moneyToString(total),
            discountAmount: moneyToString(discount),
            discountPercent: discountPercent ? discountPercent.toFixed(2) : null,
            discountReason: discount.greaterThan(0) ? (data.discount?.reason ?? null) : null,
            taxRatePercent: rate.toFixed(2),
            taxTotal: moneyToString(sumMoney(lines.map((entry) => entry.taxAmount))),
            costTotal: moneyToString(sumMoney(lines.map((entry) => entry.lineCost))),
            cashierUserId: context.actor.userId,
            cashierName: context.actor.name,
            deviceTime: data.deviceTime ? new Date(data.deviceTime) : null,
            tillSessionId: till.id,
            customerId: customer?.id ?? null,
            customerName: customer?.name ?? null,
            customerPhone: customer?.phone ?? null,
            creditAmount: moneyToString(credit),
          },
        });
        if (customer && owedAfter) {
          await tx.customerAccountEntry.create({
            data: {
              businessId,
              customerId: customer.id,
              type: "CREDIT_SALE",
              amount: moneyToString(credit),
              balanceAfter: moneyToString(owedAfter),
              saleId: sale.id,
              documentNumber: receiptNumber,
              note: overLimit ? `Over the credit limit, allowed by ${overLimitAllowedBy}.` : null,
              createdByUserId: context.actor.userId,
              createdByName: context.actor.name,
            },
          });
          if (overLimit) {
            await tx.activityLog.create({
              data: activityRow(context, {
                action: "sale.credit_over_limit",
                summary:
                  `${overLimitAllowedBy} let ${customer.name} go over their credit limit on sale ${receiptNumber}` +
                  `${overLimitAllowedBy === context.actor.name ? "" : ` (sold by ${context.actor.name})`}: ` +
                  `${formatNaira(credit)} on credit, now owing ${formatNaira(owedAfter)}.`,
                targetType: "customer",
                targetId: customer.id,
              }),
            });
          }
        }
        await tx.saleLine.createMany({
          data: lines.map(({ line, ...extra }) => ({
            businessId,
            saleId: sale.id,
            lineNumber: extra.lineNumber,
            productId: line.productId,
            productUnitId: line.productUnitId,
            productName: line.productName,
            unitName: line.unitName,
            unitFactor: line.unitFactor,
            quantity: line.quantity,
            baseQuantity: quantityToString(line.baseQuantity),
            unitPrice: moneyToString(line.unitPrice),
            lineTotal: moneyToString(line.lineTotal),
            discountAmount: moneyToString(extra.discountAmount),
            taxable: line.taxable,
            taxRatePercent: extra.taxRatePercent.toFixed(2),
            taxAmount: moneyToString(extra.taxAmount),
            baseUnitCost: extra.baseUnitCost.toFixed(4),
            lineCost: moneyToString(extra.lineCost),
            locationId: line.location.id,
            locationName: line.location.name,
          })),
        });
        await tx.stockMovement.createMany({
          data: checked.map((line) => ({
            businessId,
            productId: line.productId,
            locationId: line.location.id,
            type: "SALE" as const,
            quantityDelta: `-${quantityToString(line.baseQuantity)}`,
            unitName: line.unitName,
            unitFactor: line.unitFactor,
            unitQuantity: `-${line.quantity}`,
            documentType: "sale",
            documentId: sale.id,
            documentNumber: receiptNumber,
            userId: context.actor.userId,
            userName: context.actor.name,
          })),
        });
        // Approvals the seller gave themselves are recorded like any other, and every approval is
        // marked as used on this sale (one use each, kept by a unique index).
        const expiresAt = new Date(Date.now() + APPROVAL_MINUTES * 60_000);
        for (const approval of own) {
          const created = await tx.approval.create({
            data: {
              businessId,
              kind: approval.kind,
              method: "OWN_SALE",
              saleRequestId: data.requestId,
              fingerprint: approval.fingerprint,
              amount: moneyToString(approval.amount),
              basis: moneyToString(approval.basis),
              reason: approval.reason,
              requestedByUserId: context.actor.userId,
              requestedByName: context.actor.name,
              approvedByUserId: context.actor.userId,
              approvedByName: context.actor.name,
              expiresAt,
            },
            select: { id: true },
          });
          spent.push(created.id);
        }
        if (spent.length > 0) {
          await tx.approvalUse.createMany({ data: spent.map((approvalId) => ({ businessId, approvalId, saleId: sale.id })) });
        }

        // The payments are written last: if they cannot be saved, nothing of the sale is.
        if (payments.length > 0) {
          await tx.payment.createMany({
            data: payments.map((payment) => ({
              businessId,
              saleId: sale.id,
              methodId: payment.method.id,
              methodName: payment.method.name,
              kind: payment.method.kind,
              amount: moneyToString(payment.amount),
              tendered: payment.tendered ? moneyToString(payment.tendered) : null,
              changeGiven: payment.change ? moneyToString(payment.change) : null,
              reference: payment.reference,
              tillSessionId: till.id,
              receivedByUserId: context.actor.userId,
              receivedByName: context.actor.name,
            })),
          });
        }

        return {
          id: sale.id,
          receiptNumber,
          total: moneyToString(total),
          change: moneyToString(change),
          alreadySaved: false,
        };
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );

  for (let attempt = 1; ; attempt++) {
    try {
      return await save();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
      // The same sale arrived twice at the same moment: return the one that was saved.
      if (known === "P2002") {
        const saved = await alreadySaved();
        if (saved) return saved;
      }
      // Two savers blocked each other and the database undid this one completely: try again.
      if (known === "P2034" && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Sales: list, detail, and the record of receipt prints
// ---------------------------------------------------------------------------

/** Those who may see the sales report see every sale; a cashier sees only their own. */
function ownOnly(context: AppContext): Prisma.SaleWhereInput {
  return can(context, "report.sales.view") ? {} : { cashierUserId: context.actor.userId };
}

export type SaleSummary = {
  id: string;
  receiptNumber: string;
  createdAt: Date;
  cashierName: string;
  /** The customer's name as it was; null for a walk-in. */
  customerName: string | null;
  /** The part of the total that went on the customer's account. */
  creditAmount: string;
  lineCount: number;
  /** The first few products, for recognising the sale in the list. */
  products: string[];
  total: string;
  /** True when the sale was cancelled; it is then left out of the sum of totals. */
  cancelled: boolean;
};

const dayFilter = z
  .string()
  .trim()
  .optional()
  .default("")
  .transform((value) => (shopDayStart(value) ? value : ""));

const listSchema = z.object({
  search: z.string().trim().max(120).optional().default(""),
  from: dayFilter,
  to: dayFilter,
  page: pageNumber,
});

/**
 * One page of sales, newest first, with the total of everything that matches — cancelled
 * sales are listed but not counted in that total. A cashier is shown only their own sales.
 */
export async function listSales(
  context: AppContext,
  input: unknown = {},
): Promise<{ sales: SaleSummary[]; sumOfTotals: string; ownOnly: boolean } & Paged> {
  if (!can(context, "report.sales.view")) authorize(context, "report.ownShift.view");
  const { search, from, to, page } = parseInput(listSchema, input);

  const createdAt: Prisma.DateTimeFilter = {};
  if (from) createdAt.gte = shopDayStart(from)!;
  if (to) createdAt.lte = shopDayEnd(to)!;
  const where: Prisma.SaleWhereInput = {
    ...ownOnly(context),
    ...(from || to ? { createdAt } : {}),
    ...(search
      ? {
          OR: [
            { receiptNumber: { contains: search } },
            { cashierName: { contains: search } },
            { customerName: { contains: search } },
            { lines: { some: { productName: { contains: search } } } },
          ],
        }
      : {}),
  };
  const db = businessDb(context);
  const [total, sum, rows] = await Promise.all([
    db.sale.count({ where }),
    db.sale.aggregate({ where: { ...where, cancellation: null }, _sum: { total: true } }),
    db.sale.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        receiptNumber: true,
        createdAt: true,
        cashierName: true,
        customerName: true,
        creditAmount: true,
        total: true,
        cancellation: { select: { id: true } },
        lines: { orderBy: { lineNumber: "asc" }, take: 3, select: { productName: true } },
        _count: { select: { lines: true } },
      },
    }),
  ]);
  return {
    ownOnly: !can(context, "report.sales.view"),
    sumOfTotals: (sum._sum.total ?? new Decimal(0)).toFixed(2),
    sales: rows.map((row) => ({
      id: row.id,
      receiptNumber: row.receiptNumber,
      createdAt: row.createdAt,
      cashierName: row.cashierName,
      customerName: row.customerName,
      creditAmount: row.creditAmount.toFixed(2),
      lineCount: row._count.lines,
      products: row.lines.map((line) => line.productName),
      total: row.total.toFixed(2),
      cancelled: row.cancellation !== null,
    })),
    ...paged(total, page),
  };
}

export type SaleDetail = {
  id: string;
  receiptNumber: string;
  createdAt: Date;
  cashierName: string;
  terminalCode: string;
  paperWidth: "MM58" | "MM80";
  total: string;
  taxRatePercent: string;
  taxTotal: string;
  /** What the goods cost, and the profit — only for those who may see cost prices. */
  costTotal: string | null;
  /** How it was paid: one entry, or several when it was split. */
  payments: {
    methodName: string;
    kind: PaymentKindValue;
    amount: string;
    /** Cash only: what was handed over and the change given back. */
    tendered: string | null;
    change: string | null;
    reference: string | null;
  }[];
  /** Cash handed back to the customer in all. */
  change: string;
  /** What the items came to before any discount; the discount; and who approved it. */
  subtotal: string;
  discountAmount: string;
  discountPercent: string | null;
  discountReason: string | null;
  discountApprovedBy: string | null;
  /** Who it was sold to, as they were named then; null for a walk-in. */
  customer: { id: string; name: string; phone: string } | null;
  /** The part of the total put on the customer's account, and what they owed straight afterwards. */
  creditAmount: string;
  owedAfter: string | null;
  /** Set when the sale was cancelled: who, when and why. The sale itself is never changed. */
  cancellation: { note: string; cancelledByName: string; createdAt: Date } | null;
  /** True when this person may cancel it now: allowed to, not yet cancelled, and made today. */
  canCancel: boolean;
  /** How many times the receipt has been printed so far. */
  printCount: number;
  /** What is printed around the sale: taken from the business's settings as they are now. */
  business: { name: string; receiptHeader: string | null; receiptFooter: string | null; taxNumber: string | null };
  lines: {
    lineNumber: number;
    productName: string;
    unitName: string;
    quantity: string;
    baseQuantity: string;
    unitPrice: string;
    lineTotal: string;
    taxAmount: string;
    locationName: string;
  }[];
};

const saleIdSchema = z.object({ saleId: z.string().uuid("That sale could not be found.") });

/** One sale with everything its receipt shows. A cashier can open only their own sales. */
export async function getSale(context: AppContext, input: unknown): Promise<SaleDetail> {
  if (!can(context, "report.sales.view")) authorize(context, "report.ownShift.view");
  const { saleId } = parseInput(saleIdSchema, input);
  const db = businessDb(context);

  const [row, business] = await Promise.all([
    db.sale.findFirst({
      where: { id: saleId, ...ownOnly(context) },
      include: {
        lines: { orderBy: { lineNumber: "asc" } },
        payments: { orderBy: [{ kind: "asc" }, { methodName: "asc" }] },
        cancellation: { select: { note: true, cancelledByName: true, createdAt: true } },
        accountEntries: { where: { type: "CREDIT_SALE" }, select: { balanceAfter: true } },
        approvalUses: { select: { approval: { select: { kind: true, approvedByName: true } } } },
        terminal: { select: { paperWidth: true } },
        _count: { select: { receiptPrints: true } },
      },
    }),
    db.business.findFirst({ select: { name: true, receiptHeader: true, receiptFooter: true, taxNumber: true } }),
  ]);
  if (!row || !business) throw new NotFoundError("That sale could not be found.");
  return {
    id: row.id,
    receiptNumber: row.receiptNumber,
    createdAt: row.createdAt,
    cashierName: row.cashierName,
    terminalCode: row.terminalCode,
    paperWidth: row.terminal.paperWidth,
    total: row.total.toFixed(2),
    taxRatePercent: row.taxRatePercent.toFixed(2),
    taxTotal: row.taxTotal.toFixed(2),
    costTotal: can(context, "cost.view") ? row.costTotal.toFixed(2) : null,
    payments: row.payments.map((payment) => ({
      methodName: payment.methodName,
      kind: payment.kind,
      amount: payment.amount.toFixed(2),
      tendered: payment.tendered?.toFixed(2) ?? null,
      change: payment.changeGiven?.toFixed(2) ?? null,
      reference: payment.reference,
    })),
    change: moneyToString(sumMoney(row.payments.map((payment) => new Decimal(payment.changeGiven?.toFixed(2) ?? "0")))),
    subtotal: moneyToString(new Decimal(row.total.toFixed(2)).plus(row.discountAmount.toFixed(2))),
    discountAmount: row.discountAmount.toFixed(2),
    discountPercent: row.discountPercent?.toFixed(2) ?? null,
    discountReason: row.discountReason,
    discountApprovedBy: row.approvalUses.find((use) => use.approval.kind === "DISCOUNT")?.approval.approvedByName ?? null,
    customer: row.customerId ? { id: row.customerId, name: row.customerName ?? "", phone: row.customerPhone ?? "" } : null,
    creditAmount: row.creditAmount.toFixed(2),
    owedAfter: row.accountEntries[0]?.balanceAfter.toFixed(2) ?? null,
    cancellation: row.cancellation,
    canCancel: can(context, "sale.cancel") && row.cancellation === null && shopToday(row.createdAt) === shopToday(),
    printCount: row._count.receiptPrints,
    business,
    lines: row.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productName: line.productName,
      unitName: line.unitName,
      quantity: line.quantity.toFixed(3),
      baseQuantity: line.baseQuantity.toFixed(3),
      unitPrice: line.unitPrice.toFixed(2),
      lineTotal: line.lineTotal.toFixed(2),
      taxAmount: line.taxAmount.toFixed(2),
      locationName: line.locationName,
    })),
  };
}

/**
 * Notes that a receipt is being printed. The first print is the original; every later one
 * is a reprint, which is also written to the activity log.
 */
export async function recordReceiptPrint(context: AppContext, input: unknown): Promise<{ reprint: boolean }> {
  if (!can(context, "report.sales.view")) authorize(context, "report.ownShift.view");
  const businessId = businessIdOf(context);
  const { saleId } = parseInput(saleIdSchema, input);
  const db = businessDb(context);

  const sale = await db.sale.findFirst({
    where: { id: saleId, ...ownOnly(context) },
    select: { id: true, receiptNumber: true, _count: { select: { receiptPrints: true } } },
  });
  if (!sale) throw new NotFoundError("That sale could not be found.");
  const reprint = sale._count.receiptPrints > 0;

  await db.$transaction(async (tx) => {
    await tx.saleReceiptPrint.create({
      data: { businessId, saleId: sale.id, printedByUserId: context.actor.userId, printedByName: context.actor.name },
    });
    if (reprint) {
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "sale.receipt_reprinted",
          summary: `${context.actor.name} printed receipt ${sale.receiptNumber} again.`,
          targetType: "sale",
          targetId: sale.id,
        }),
      });
    }
  });
  return { reprint };
}

// ---------------------------------------------------------------------------
// Cancelling a sale
// ---------------------------------------------------------------------------

const cancelSchema = z.object({
  saleId: z.string().uuid("That sale could not be found."),
  note: z.string().trim().min(5, "Say why the sale is being cancelled.").max(300, "The note is too long (300 characters at most)."),
});

export type CancelResult = { id: string; receiptNumber: string; refunded: string; alreadyCancelled: boolean };

/**
 * Cancels a whole sale on the day it was made (SPEC C48) — for example when the customer
 * changes their mind. Admins, managers and owners only; a note is required.
 *
 * Nothing about the sale is changed or removed. In one transaction: a cancellation record
 * is written (one per sale, so it can only happen once), the goods go back where they came
 * from by new stock movements, and every payment is given back by a refund record of the
 * same method. A cash refund comes out of the till that is open at the sale's terminal, so
 * that till must be open.
 */
export async function cancelSale(context: AppContext, input: unknown): Promise<CancelResult> {
  authorize(context, "sale.cancel");
  const businessId = businessIdOf(context);
  const data = parseInput(cancelSchema, input);
  const db = businessDb(context);

  const load = () =>
    db.sale.findFirst({
      where: { id: data.saleId },
      include: {
        lines: { orderBy: { lineNumber: "asc" } },
        payments: { orderBy: [{ kind: "asc" }, { methodName: "asc" }] },
        cancellation: { select: { id: true } },
      },
    });
  const sale = await load();
  if (!sale) throw new NotFoundError("That sale could not be found.");
  const refunded = moneyToString(sumMoney(sale.payments.map((payment) => new Decimal(payment.amount.toFixed(2)))));
  const already = (): CancelResult => ({ id: sale.id, receiptNumber: sale.receiptNumber, refunded, alreadyCancelled: true });
  if (sale.cancellation) return already();
  if (shopToday(sale.createdAt) !== shopToday()) {
    throw new ValidationError("A sale can only be cancelled on the day it was made. For an earlier sale, the goods must be returned instead.");
  }

  // What comes back, per product and place, in base units and at the cost it left with.
  type Back = { quantity: Decimal; cost: Decimal; places: Map<string, Decimal> };
  const perProduct = new Map<string, Back>();
  for (const line of sale.lines) {
    const back = perProduct.get(line.productId) ?? { quantity: new Decimal(0), cost: new Decimal(0), places: new Map<string, Decimal>() };
    const quantity = new Decimal(line.baseQuantity.toFixed(3));
    back.quantity = back.quantity.plus(quantity);
    back.cost = back.cost.plus(line.lineCost.toFixed(2));
    back.places.set(line.locationId, (back.places.get(line.locationId) ?? new Decimal(0)).plus(quantity));
    perProduct.set(line.productId, back);
  }
  const cashToRefund = sumMoney(sale.payments.filter((payment) => payment.kind === "CASH").map((payment) => new Decimal(payment.amount.toFixed(2))));
  const hasCash = cashToRefund.greaterThan(0);

  const save = () =>
    db.$transaction(
      async (tx) => {
        // The terminal's "turn", as for selling and for opening and closing its till.
        await tx.terminal.update({ where: { id: sale.terminalId }, data: { updatedAt: new Date() }, select: { id: true } });
        const till = await tx.tillSession.findFirst({
          where: { terminalId: sale.terminalId, close: null },
          select: { id: true, openingFloat: true },
        });
        if (hasCash && !till) {
          throw new ValidationError(
            `Nothing was cancelled: the till of ${sale.terminalCode} is not open, and the cash refund has to come out of it. Open the till, then cancel the sale.`,
          );
        }
        if (hasCash && till) {
          // Cash cannot be handed back out of a drawer that does not hold it.
          const [taken, repaid, paidBack] = await Promise.all([
            tx.payment.aggregate({ where: { tillSessionId: till.id, kind: "CASH" }, _sum: { amount: true } }),
            tx.repayment.aggregate({ where: { tillSessionId: till.id, kind: "CASH" }, _sum: { amount: true } }),
            tx.refund.aggregate({ where: { tillSessionId: till.id, kind: "CASH" }, _sum: { amount: true } }),
          ]);
          const inDrawer = new Decimal(till.openingFloat.toFixed(2))
            .plus(taken._sum.amount?.toFixed(2) ?? "0")
            .plus(repaid._sum.amount?.toFixed(2) ?? "0")
            .minus(paidBack._sum.amount?.toFixed(2) ?? "0");
          if (inDrawer.lessThan(cashToRefund)) {
            throw new ValidationError(
              `Nothing was cancelled: ${formatNaira(cashToRefund)} in cash has to be given back, but the till of ${sale.terminalCode} should only hold ${formatNaira(inDrawer)}.`,
            );
          }
        }

        // Writing this first is what stops a second cancellation: there can be only one per sale.
        const cancellation = await tx.saleCancellation.create({
          data: {
            businessId,
            saleId: sale.id,
            note: data.note,
            cancelledByUserId: context.actor.userId,
            cancelledByName: context.actor.name,
          },
        });

        // A credit sale: what it put on the customer's account is taken off again. The customer's
        // "turn" comes before any product's, as when the sale was made.
        const credit = new Decimal(sale.creditAmount.toFixed(2));
        if (sale.customerId && credit.greaterThan(0)) {
          const lowered = await tx.customer.updateMany({
            where: { id: sale.customerId, balance: { gte: moneyToString(credit) } },
            data: { balance: { decrement: moneyToString(credit) } },
          });
          // Checked after taking the customer's turn, so a repayment cannot slip in between.
          const repaid = await tx.repaymentAllocation.count({ where: { saleId: sale.id } });
          if (repaid > 0 || lowered.count !== 1) {
            throw new ValidationError(
              "Nothing was cancelled: part of this sale's debt has already been repaid, so it cannot simply be cancelled. The goods must be returned instead.",
            );
          }
          const now = await tx.customer.findFirst({ where: { id: sale.customerId }, select: { balance: true } });
          await tx.customerAccountEntry.create({
            data: {
              businessId,
              customerId: sale.customerId,
              type: "SALE_CANCELLED",
              amount: moneyToString(credit.negated()),
              balanceAfter: now?.balance.toFixed(2) ?? "0.00",
              saleId: sale.id,
              documentNumber: sale.receiptNumber,
              note: data.note,
              createdByUserId: context.actor.userId,
              createdByName: context.actor.name,
            },
          });
        }

        // Always in the same order (product, then location), as for every other stock change.
        for (const productId of [...perProduct.keys()].sort()) {
          const back = perProduct.get(productId)!;
          const product = await tx.product.update({
            where: { id: productId },
            data: { updatedAt: new Date() },
            select: { averageCost: true },
          });
          const before = await tx.stockBalance.aggregate({ where: { productId }, _sum: { quantity: true } });
          // The goods come back at the cost they left with.
          const average = movingAverageCost({
            quantityBefore: new Decimal(before._sum.quantity?.toFixed(3) ?? "0"),
            averageBefore: new Decimal(product.averageCost.toFixed(4)),
            quantityAdded: back.quantity,
            costAdded: back.cost,
          });
          await tx.product.update({ where: { id: productId }, data: { averageCost: average.toFixed(4) } });

          for (const [locationId, quantity] of [...back.places.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            const raised = await tx.stockBalance.updateMany({
              where: { productId, locationId },
              data: { quantity: { increment: quantityToString(quantity) } },
            });
            if (raised.count === 0) {
              await tx.stockBalance.create({ data: { businessId, productId, locationId, quantity: quantityToString(quantity) } });
            }
          }
        }

        await tx.stockMovement.createMany({
          data: sale.lines.map((line) => ({
            businessId,
            productId: line.productId,
            locationId: line.locationId,
            type: "SALE_CANCELLATION" as const,
            quantityDelta: line.baseQuantity.toFixed(3),
            unitName: line.unitName,
            unitFactor: line.unitFactor.toFixed(3),
            unitQuantity: line.quantity.toFixed(3),
            documentType: "sale_cancellation",
            documentId: cancellation.id,
            documentNumber: sale.receiptNumber,
            userId: context.actor.userId,
            userName: context.actor.name,
          })),
        });

        if (sale.payments.length > 0) {
          await tx.refund.createMany({
            data: sale.payments.map((payment) => ({
              businessId,
              saleId: sale.id,
              cancellationId: cancellation.id,
              paymentId: payment.id,
              methodId: payment.methodId,
              methodName: payment.methodName,
              kind: payment.kind,
              amount: payment.amount.toFixed(2),
              tillSessionId: till?.id ?? null,
              refundedByUserId: context.actor.userId,
              refundedByName: context.actor.name,
            })),
          });
        }

        await tx.activityLog.create({
          data: activityRow(context, {
            action: "sale.cancelled",
            summary:
              `${context.actor.name} cancelled sale ${sale.receiptNumber} (${formatNaira(new Decimal(sale.total.toFixed(2)))}, sold by ${sale.cashierName}). ` +
              (sale.payments.length > 0
                ? `Refunded: ${sale.payments.map((payment) => `${formatNaira(new Decimal(payment.amount.toFixed(2)))} ${payment.methodName}`).join(", ")}. `
                : "") +
              `Reason: ${data.note}`,
            targetType: "sale",
            targetId: sale.id,
            details: { receiptNumber: sale.receiptNumber, total: sale.total.toFixed(2), refunded },
          }),
        });

        return { id: sale.id, receiptNumber: sale.receiptNumber, refunded, alreadyCancelled: false };
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );

  for (let attempt = 1; ; attempt++) {
    try {
      return await save();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
      // Someone else cancelled it at the same moment: it is cancelled, once.
      if (known === "P2002" && (await load())?.cancellation) return already();
      if (known === "P2034" && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}
