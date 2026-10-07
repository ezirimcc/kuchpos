import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import {
  ADJUSTMENT_REASON_VALUES,
  type AdjustmentReasonValue,
  type AdjustmentStatus,
  reasonLabel,
} from "@/lib/adjustment-reasons";
import { Decimal } from "@/lib/decimal";
import { adjustmentNumber, countNumber, plainNumber, shopDayEnd, shopDayStart } from "@/lib/format";
import { parseQuantity, quantityToString, toBaseQuantity } from "@/lib/quantity";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { optionalText } from "@/server/input";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { takeDocumentNumber } from "@/server/document-number";
import { authorize, can } from "@/server/permissions";

/**
 * Stock adjustments for the business in use: adding to or taking from the stock of one
 * location, always with a reason per line.
 *
 * An adjustment is stored as a DIFFERENCE ("5 fewer"), never as "set to 95", so whatever
 * is sold or moved between entering it and applying it is not wiped out.
 *
 * The adjustment document is add-only. Stock changes only when a decision with outcome
 * APPLIED is written for it — in the same transaction as the movements and the balances.
 * For someone who may approve (admin, manager, owner) that happens at once; a storekeeper's
 * adjustment waits until one of them approves or rejects it. There is exactly one decision
 * per adjustment (a unique index), so it can never be applied twice.
 * Adjustments do not change the average cost.
 */

const MAX_LINES = 500;
const MAX_UNIT_QUANTITY = new Decimal("9999999.999");
const MAX_BASE_QUANTITY = new Decimal("999999999.999");
/** How many times to try again when the database reports that two savers got in each other's way. */
const MAX_ATTEMPTS = 3;

type Db = ReturnType<typeof businessDb>;
type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

type PreparedLine = {
  /** Where this line's problems are reported on the form (`lines.<key>.quantity`). */
  key: string;
  productId: string;
  productUnitId: string;
  productName: string;
  baseUnitName: string;
  unitName: string;
  unitFactor: string;
  /** Signed: negative takes stock out. */
  quantity: string;
  baseQuantity: Decimal;
  reason: AdjustmentReasonValue;
};

export type AdjustmentResult = { id: string; number: number; status: AdjustmentStatus; alreadySaved: boolean };

const statusOf = (decision: { outcome: "APPLIED" | "REJECTED" } | null | undefined): AdjustmentStatus =>
  decision ? decision.outcome : "PENDING";

const signed = (value: string) => (value.startsWith("-") ? `−${plainNumber(value.slice(1))}` : `+${plainNumber(value)}`);

// ---------------------------------------------------------------------------
// Changing the stock (only ever called inside a transaction that also writes the decision)
// ---------------------------------------------------------------------------

async function applyToStock(
  tx: Tx,
  context: AppContext,
  adjustment: { id: string; number: number; locationId: string; locationName: string },
  lines: PreparedLine[],
): Promise<void> {
  const businessId = businessIdOf(context);
  const perProduct = new Map<string, Decimal>();
  for (const line of lines) {
    perProduct.set(line.productId, (perProduct.get(line.productId) ?? new Decimal(0)).plus(line.baseQuantity));
  }

  const short: Record<string, string> = {};
  const problems: string[] = [];
  // Always in the same order, so two people saving at the same moment cannot block each other.
  for (const productId of [...perProduct.keys()].sort()) {
    const net = perProduct.get(productId)!;
    // The product's "turn", as for deliveries and transfers.
    await tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() }, select: { id: true } });
    if (net.isZero()) continue;

    if (net.greaterThan(0)) {
      const raised = await tx.stockBalance.updateMany({
        where: { productId, locationId: adjustment.locationId },
        data: { quantity: { increment: quantityToString(net) } },
      });
      if (raised.count === 0) {
        await tx.stockBalance.create({
          data: { businessId, productId, locationId: adjustment.locationId, quantity: quantityToString(net) },
        });
      }
      continue;
    }

    // Taken out only if that much is there — one statement, so stock can never go below zero.
    const needed = quantityToString(net.negated());
    const lowered = await tx.stockBalance.updateMany({
      where: { productId, locationId: adjustment.locationId, quantity: { gte: needed } },
      data: { quantity: { decrement: needed } },
    });
    if (lowered.count !== 1) {
      const there = await tx.stockBalance.findFirst({
        where: { productId, locationId: adjustment.locationId },
        select: { quantity: true },
      });
      const line = lines.find((candidate) => candidate.productId === productId)!;
      const message =
        `Only ${plainNumber(there?.quantity.toFixed(3) ?? "0")} ${line.baseUnitName} of "${line.productName}" is in ` +
        `${adjustment.locationName}. This adjustment takes out ${plainNumber(needed)} ${line.baseUnitName}.`;
      problems.push(message);
      for (const other of lines) if (other.productId === productId) short[`lines.${other.key}.quantity`] = message;
    }
  }
  // Throwing here undoes everything in the transaction, including products that had enough.
  if (problems.length > 0) {
    throw new ValidationError(`Stock was not changed. ${problems.join(" ")}`, short);
  }

  await tx.stockMovement.createMany({
    data: lines.map((line) => ({
      businessId,
      productId: line.productId,
      locationId: adjustment.locationId,
      type: "ADJUSTMENT" as const,
      quantityDelta: quantityToString(line.baseQuantity),
      unitName: line.unitName,
      unitFactor: line.unitFactor,
      unitQuantity: line.quantity,
      documentType: "stock_adjustment",
      documentId: adjustment.id,
      documentNumber: adjustmentNumber(adjustment.number),
      userId: context.actor.userId,
      userName: context.actor.name,
    })),
  });
}

function describe(lines: PreparedLine[]): string {
  return (
    lines
      .slice(0, 5)
      .map((line) => `${signed(line.quantity)} ${line.unitName} of ${line.productName} (${reasonLabel(line.reason)})`)
      .join(", ") + (lines.length > 5 ? ` and ${lines.length - 5} more` : "")
  );
}

/** Saves an adjustment and, if the person may approve, applies it in the same transaction. */
async function saveAdjustment(
  context: AppContext,
  db: Db,
  input: {
    requestId: string;
    location: { id: string; name: string };
    count: { id: string; number: number } | null;
    note: string | null;
    lines: PreparedLine[];
  },
): Promise<AdjustmentResult> {
  const businessId = businessIdOf(context);
  const appliesAtOnce = can(context, "stock.adjust.approve");

  const alreadySaved = async (): Promise<AdjustmentResult | null> => {
    const saved = await db.stockAdjustment.findFirst({
      where: { requestId: input.requestId },
      select: { id: true, number: true, decision: { select: { outcome: true } } },
    });
    return saved ? { id: saved.id, number: saved.number, status: statusOf(saved.decision), alreadySaved: true } : null;
  };

  const save = () =>
    db.$transaction(
      async (tx) => {
        const number = await takeDocumentNumber(tx, businessId, "STOCK_ADJUSTMENT");
        if (appliesAtOnce) {
          // Each product's "turn" is taken before anything that refers to the product is
          // written (see receiveGoods for why).
          for (const productId of [...new Set(input.lines.map((line) => line.productId))].sort()) {
            await tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() }, select: { id: true } });
          }
        }

        const adjustment = await tx.stockAdjustment.create({
          data: {
            businessId,
            requestId: input.requestId,
            number,
            locationId: input.location.id,
            locationName: input.location.name,
            countId: input.count?.id ?? null,
            note: input.note,
            createdByUserId: context.actor.userId,
            createdByName: context.actor.name,
          },
        });
        await tx.stockAdjustmentLine.createMany({
          data: input.lines.map((line, position) => ({
            businessId,
            adjustmentId: adjustment.id,
            lineNumber: position + 1,
            productId: line.productId,
            productUnitId: line.productUnitId,
            productName: line.productName,
            unitName: line.unitName,
            unitFactor: line.unitFactor,
            quantity: line.quantity,
            baseQuantity: quantityToString(line.baseQuantity),
            reason: line.reason,
          })),
        });

        const where = { id: adjustment.id, number, locationId: input.location.id, locationName: input.location.name };
        if (appliesAtOnce) {
          await tx.stockAdjustmentDecision.create({
            data: {
              businessId,
              adjustmentId: adjustment.id,
              outcome: "APPLIED",
              decidedByUserId: context.actor.userId,
              decidedByName: context.actor.name,
            },
          });
          await applyToStock(tx, context, where, input.lines);
        }

        const from = input.count ? ` from count ${countNumber(input.count.number)}` : "";
        await tx.activityLog.create({
          data: activityRow(context, {
            action: appliesAtOnce ? "stock.adjusted" : "stock.adjustment_requested",
            summary:
              `${context.actor.name} ${appliesAtOnce ? "adjusted stock" : "asked for a stock adjustment"} in ${input.location.name} ` +
              `(${adjustmentNumber(number)}${from}): ${describe(input.lines)}.` +
              (input.note ? ` Note: ${input.note}` : "") +
              (appliesAtOnce ? "" : " Waiting for approval."),
            targetType: "stock_adjustment",
            targetId: adjustment.id,
            details: { number, location: input.location.name, lines: input.lines.length, applied: appliesAtOnce },
          }),
        });

        const status: AdjustmentStatus = appliesAtOnce ? "APPLIED" : "PENDING";
        return { id: adjustment.id, number, status, alreadySaved: false };
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );

  for (let attempt = 1; ; attempt++) {
    try {
      return await save();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
      if (known === "P2002") {
        // The same submission arrived twice at the same moment: return the one that was saved.
        const saved = await alreadySaved();
        if (saved) return saved;
        // Otherwise it is the "one adjustment per count" rule.
        if (input.count) {
          throw new ValidationError("An adjustment has already been recorded for this count. Reload the page to see it.");
        }
      }
      // Two savers blocked each other and the database undid this one completely: try again.
      if (known === "P2034" && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// What the "new adjustment" screen needs
// ---------------------------------------------------------------------------

export type AdjustmentProduct = {
  id: string;
  name: string;
  code: string | null;
  allowsFraction: boolean;
  baseUnitName: string;
  /** Units in use, smallest first. */
  units: { id: string; name: string; factor: string; isBase: boolean }[];
  /** How much is in each location now, in base units (a missing location means none). */
  stock: Record<string, string>;
};

export type AdjustmentOptions = {
  /** True when this person's adjustments change stock at once; false when they wait for approval. */
  appliesAtOnce: boolean;
  locations: { id: string; name: string; kind: "SHELF" | "STOREROOM" }[];
  products: AdjustmentProduct[];
};

export async function getAdjustmentOptions(context: AppContext): Promise<AdjustmentOptions> {
  authorize(context, "stock.adjust.request");
  const db = businessDb(context);
  const [locations, products] = await Promise.all([
    db.location.findMany({ orderBy: { kind: "desc" }, select: { id: true, name: true, kind: true } }),
    db.product.findMany({
      where: { deactivatedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        code: true,
        allowsFraction: true,
        units: {
          where: { retiredAt: null },
          orderBy: { factor: "asc" },
          select: { id: true, name: true, factor: true, isBase: true },
        },
        stockBalances: { select: { locationId: true, quantity: true } },
      },
    }),
  ]);
  return {
    appliesAtOnce: can(context, "stock.adjust.approve"),
    locations,
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
      allowsFraction: product.allowsFraction,
      baseUnitName: product.units.find((unit) => unit.isBase)?.name ?? "",
      units: product.units.map((unit) => ({ id: unit.id, name: unit.name, factor: unit.factor.toFixed(3), isBase: unit.isBase })),
      stock: Object.fromEntries(product.stockBalances.map((balance) => [balance.locationId, balance.quantity.toFixed(3)])),
    })),
  };
}

// ---------------------------------------------------------------------------
// Recording an adjustment directly
// ---------------------------------------------------------------------------

const requestIdSchema = z.string().uuid("This form has expired. Reload the page and enter the adjustment again.");
const noteSchema = optionalText(300, "The note is too long (300 characters at most).").optional().default("");
const reasonSchema = z.enum(ADJUSTMENT_REASON_VALUES, { message: "Choose a reason." });

const recordSchema = z.object({
  requestId: requestIdSchema,
  locationId: z.string().uuid("Choose the location."),
  note: noteSchema,
  lines: z
    .array(
      z.object({
        productId: z.string().trim(),
        unitId: z.string().trim(),
        direction: z.enum(["add", "remove"], { message: "Choose whether stock is being added or taken out." }),
        quantity: z.string().trim(),
        reason: reasonSchema,
      }),
    )
    .min(1, "Add at least one product to the adjustment.")
    .max(MAX_LINES, `An adjustment can have at most ${MAX_LINES} lines.`),
});

function requireNoteForOther(lines: { reason: AdjustmentReasonValue }[], note: string, fieldErrors: Record<string, string>) {
  if (lines.some((line) => line.reason === "OTHER") && note.length < 5) {
    fieldErrors.note = 'Explain the reason in the note when "Other" is chosen.';
  }
}

/**
 * Adds stock to, or takes stock from, one location, with a reason for every line.
 * An admin's, manager's or owner's adjustment changes stock at once; a storekeeper's is
 * saved and waits for approval. `requestId` makes a repeated submission harmless.
 */
export async function recordAdjustment(context: AppContext, input: unknown): Promise<AdjustmentResult> {
  authorize(context, "stock.adjust.request");
  const data = parseInput(recordSchema, input);
  const db = businessDb(context);

  const existing = await db.stockAdjustment.findFirst({
    where: { requestId: data.requestId },
    select: { id: true, number: true, decision: { select: { outcome: true } } },
  });
  if (existing) return { id: existing.id, number: existing.number, status: statusOf(existing.decision), alreadySaved: true };

  const fieldErrors: Record<string, string> = {};
  requireNoteForOther(data.lines, data.note ?? "", fieldErrors);

  const location = await db.location.findFirst({ where: { id: data.locationId }, select: { id: true, name: true } });
  if (!location) fieldErrors.locationId = "Choose the location.";

  const productIds = [...new Set(data.lines.map((line) => line.productId).filter(Boolean))];
  const products = await db.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      name: true,
      allowsFraction: true,
      deactivatedAt: true,
      units: { select: { id: true, name: true, factor: true, isBase: true, retiredAt: true } },
    },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const prepared: PreparedLine[] = [];
  data.lines.forEach((line, index) => {
    const at = (field: string) => `lines.${index}.${field}`;
    const product = productById.get(line.productId);
    if (!product) {
      fieldErrors[at("productId")] = "Choose a product.";
      return;
    }
    if (product.deactivatedAt) {
      fieldErrors[at("productId")] = `"${product.name}" is out of use. Bring it back first if its stock must be adjusted.`;
      return;
    }
    const unit = product.units.find((candidate) => candidate.id === line.unitId);
    if (!unit || unit.retiredAt) {
      fieldErrors[at("unitId")] = "Choose one of this product's units.";
      return;
    }
    try {
      const quantity = parseQuantity(line.quantity);
      if (!quantity.greaterThan(0) || quantity.greaterThan(MAX_UNIT_QUANTITY)) throw new Error("out of range");
      if (!product.allowsFraction && !quantity.isInteger()) {
        fieldErrors[at("quantity")] = `"${product.name}" comes in whole units only. Enter a whole number.`;
        return;
      }
      const baseQuantity = toBaseQuantity(quantity, new Decimal(unit.factor.toFixed(3)));
      if (baseQuantity.greaterThan(MAX_BASE_QUANTITY)) throw new Error("too large");
      const sign = line.direction === "remove" ? -1 : 1;
      prepared.push({
        key: String(index),
        productId: product.id,
        productUnitId: unit.id,
        productName: product.name,
        baseUnitName: product.units.find((candidate) => candidate.isBase)?.name ?? "",
        unitName: unit.name,
        unitFactor: unit.factor.toFixed(3),
        quantity: quantityToString(quantity.times(sign)),
        baseQuantity: baseQuantity.times(sign),
        reason: line.reason,
      });
    } catch {
      fieldErrors[at("quantity")] = "Enter how many, as a number greater than zero (up to 3 decimal places).";
    }
  });

  if (Object.keys(fieldErrors).length > 0 || !location) {
    throw new ValidationError("Nothing was saved. Please correct the highlighted fields.", fieldErrors);
  }
  return saveAdjustment(context, db, { requestId: data.requestId, location, count: null, note: data.note || null, lines: prepared });
}

// ---------------------------------------------------------------------------
// Turning the differences of a stock count into an adjustment
// ---------------------------------------------------------------------------

const fromCountSchema = z.object({
  requestId: requestIdSchema,
  countId: z.string().uuid("That count could not be found."),
  note: noteSchema,
  /** The reason for each difference, by the count's line number. */
  reasons: z.array(z.object({ lineNumber: z.number().int().positive(), reason: z.string() })).max(MAX_LINES),
});

/**
 * Records one adjustment for all the differences a stock count found. The amounts come from
 * the saved count, never from the browser; the browser supplies only a reason per difference.
 * A count can be adjusted once.
 */
export async function adjustFromCount(context: AppContext, input: unknown): Promise<AdjustmentResult> {
  authorize(context, "stock.adjust.request");
  const data = parseInput(fromCountSchema, input);
  const db = businessDb(context);

  const existing = await db.stockAdjustment.findFirst({
    where: { requestId: data.requestId },
    select: { id: true, number: true, decision: { select: { outcome: true } } },
  });
  if (existing) return { id: existing.id, number: existing.number, status: statusOf(existing.decision), alreadySaved: true };

  const count = await db.stockCount.findFirst({
    where: { id: data.countId },
    include: { lines: { orderBy: { lineNumber: "asc" } }, adjustment: { select: { number: true } } },
  });
  if (!count) throw new NotFoundError("That count could not be found.");
  if (count.adjustment) {
    throw new ValidationError(`Adjustment ${adjustmentNumber(count.adjustment.number)} has already been recorded for this count.`);
  }
  const differences = count.lines.filter((line) => !line.difference.isZero());
  if (differences.length === 0) {
    throw new ValidationError("This count found no differences, so there is nothing to adjust.");
  }

  const fieldErrors: Record<string, string> = {};
  const reasonByLine = new Map(data.reasons.map((entry) => [entry.lineNumber, entry.reason]));
  const prepared: PreparedLine[] = [];
  for (const line of differences) {
    const reason = reasonSchema.safeParse(reasonByLine.get(line.lineNumber));
    if (!reason.success) {
      fieldErrors[`lines.${line.lineNumber}.reason`] = "Choose a reason.";
      continue;
    }
    prepared.push({
      key: String(line.lineNumber),
      productId: line.productId,
      productUnitId: line.baseUnitId,
      productName: line.productName,
      baseUnitName: line.baseUnitName,
      unitName: line.baseUnitName,
      unitFactor: "1.000",
      quantity: line.difference.toFixed(3),
      baseQuantity: new Decimal(line.difference.toFixed(3)),
      reason: reason.data,
    });
  }
  requireNoteForOther(prepared, data.note ?? "", fieldErrors);
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError("Nothing was saved. Choose a reason for every difference.", fieldErrors);
  }

  return saveAdjustment(context, db, {
    requestId: data.requestId,
    location: { id: count.locationId, name: count.locationName },
    count: { id: count.id, number: count.number },
    note: data.note || null,
    lines: prepared,
  });
}

// ---------------------------------------------------------------------------
// Approving or rejecting
// ---------------------------------------------------------------------------

const decideSchema = z.object({
  adjustmentId: z.string().uuid("That adjustment could not be found."),
  outcome: z.enum(["APPLIED", "REJECTED"]),
  note: noteSchema,
});

export type DecisionResult = { id: string; number: number; status: AdjustmentStatus; alreadyDecided: boolean };

/**
 * Approves (and applies) or rejects an adjustment that is waiting. Admins, managers and
 * owners only. There is one decision per adjustment: a second attempt with the same outcome
 * changes nothing, and one with the other outcome is refused. A rejection needs a note.
 * Approval is refused, and the adjustment left waiting, if the stock is no longer there.
 */
export async function decideAdjustment(context: AppContext, input: unknown): Promise<DecisionResult> {
  authorize(context, "stock.adjust.approve");
  const businessId = businessIdOf(context);
  const data = parseInput(decideSchema, input);
  const db = businessDb(context);

  const load = () =>
    db.stockAdjustment.findFirst({
      where: { id: data.adjustmentId },
      include: { lines: { orderBy: { lineNumber: "asc" } }, decision: true },
    });
  const adjustment = await load();
  if (!adjustment) throw new NotFoundError("That adjustment could not be found.");

  const settled = (decision: { outcome: "APPLIED" | "REJECTED"; decidedByName: string }): DecisionResult => {
    if (decision.outcome !== data.outcome) {
      throw new ValidationError(
        `This adjustment was already ${decision.outcome === "APPLIED" ? "approved" : "rejected"} by ${decision.decidedByName}. Nothing was changed.`,
      );
    }
    return { id: adjustment.id, number: adjustment.number, status: decision.outcome, alreadyDecided: true };
  };
  if (adjustment.decision) return settled(adjustment.decision);

  if (data.outcome === "REJECTED" && (data.note ?? "").length < 5) {
    throw new ValidationError("Nothing was saved. Say why the adjustment is rejected.", {
      note: "Say why the adjustment is rejected.",
    });
  }

  const baseUnits = new Map(
    (
      await db.productUnit.findMany({
        where: { productId: { in: adjustment.lines.map((line) => line.productId) }, isBase: true },
        select: { productId: true, name: true },
      })
    ).map((unit) => [unit.productId, unit.name]),
  );
  const lines: PreparedLine[] = adjustment.lines.map((line) => ({
    key: String(line.lineNumber),
    productId: line.productId,
    productUnitId: line.productUnitId,
    productName: line.productName,
    baseUnitName: baseUnits.get(line.productId) ?? "",
    unitName: line.unitName,
    unitFactor: line.unitFactor.toFixed(3),
    quantity: line.quantity.toFixed(3),
    baseQuantity: new Decimal(line.baseQuantity.toFixed(3)),
    reason: line.reason,
  }));

  const save = () =>
    db.$transaction(
      async (tx) => {
        // Writing the decision first is what stops a second decision: the unique index lets
        // only one exist, and a second saver waits here until the first has finished.
        await tx.stockAdjustmentDecision.create({
          data: {
            businessId,
            adjustmentId: adjustment.id,
            outcome: data.outcome,
            note: data.note || null,
            decidedByUserId: context.actor.userId,
            decidedByName: context.actor.name,
          },
        });
        if (data.outcome === "APPLIED") {
          await applyToStock(tx, context, adjustment, lines);
        }
        await tx.activityLog.create({
          data: activityRow(context, {
            action: data.outcome === "APPLIED" ? "stock.adjustment_approved" : "stock.adjustment_rejected",
            summary:
              `${context.actor.name} ${data.outcome === "APPLIED" ? "approved" : "rejected"} stock adjustment ` +
              `${adjustmentNumber(adjustment.number)} in ${adjustment.locationName}, entered by ${adjustment.createdByName}: ` +
              `${describe(lines)}.` +
              (data.note ? ` Note: ${data.note}` : ""),
            targetType: "stock_adjustment",
            targetId: adjustment.id,
            details: { number: adjustment.number, outcome: data.outcome, requestedBy: adjustment.createdByName },
          }),
        });
        return { id: adjustment.id, number: adjustment.number, status: data.outcome, alreadyDecided: false };
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );

  for (let attempt = 1; ; attempt++) {
    try {
      return await save();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
      // Someone else decided at the same moment: report what they decided.
      if (known === "P2002") {
        const now = await load();
        if (now?.decision) return settled(now.decision);
      }
      if (known === "P2034" && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Adjustments: list and detail
// ---------------------------------------------------------------------------

export type AdjustmentSummary = {
  id: string;
  number: number;
  locationName: string;
  status: AdjustmentStatus;
  lineCount: number;
  /** The first few products, for recognising the adjustment in the list. */
  products: string[];
  countNumber: number | null;
  createdByName: string;
  createdAt: Date;
  decidedByName: string | null;
  decidedAt: Date | null;
};

const dayFilter = z
  .string()
  .trim()
  .optional()
  .default("")
  .transform((value) => (shopDayStart(value) ? value : ""));

const listSchema = z.object({
  search: z.string().trim().max(120).optional().default(""),
  status: z
    .string()
    .optional()
    .default("")
    .transform((value) => (["pending", "applied", "rejected"].includes(value) ? value : "")),
  from: dayFilter,
  to: dayFilter,
  page: pageNumber,
});

/** One page of adjustments, newest first, with how many are waiting for approval. */
export async function listAdjustments(
  context: AppContext,
  input: unknown = {},
): Promise<{ adjustments: AdjustmentSummary[]; waiting: number; canRecord: boolean; canDecide: boolean } & Paged> {
  authorize(context, "report.stock.view");
  const { search, status, from, to, page } = parseInput(listSchema, input);

  const createdAt: Prisma.DateTimeFilter = {};
  if (from) createdAt.gte = shopDayStart(from)!;
  if (to) createdAt.lte = shopDayEnd(to)!;
  const numberSearch = /^(?:ad-?)?0*(\d{1,9})$/i.exec(search)?.[1];

  const where: Prisma.StockAdjustmentWhereInput = {
    ...(from || to ? { createdAt } : {}),
    ...(status === "pending" ? { decision: null } : {}),
    ...(status === "applied" ? { decision: { outcome: "APPLIED" } } : {}),
    ...(status === "rejected" ? { decision: { outcome: "REJECTED" } } : {}),
    ...(search
      ? {
          OR: [
            { lines: { some: { productName: { contains: search } } } },
            { createdByName: { contains: search } },
            ...(numberSearch ? [{ number: Number.parseInt(numberSearch, 10) }] : []),
          ],
        }
      : {}),
  };
  const db = businessDb(context);
  const [total, waiting, rows] = await Promise.all([
    db.stockAdjustment.count({ where }),
    db.stockAdjustment.count({ where: { decision: null } }),
    db.stockAdjustment.findMany({
      where,
      orderBy: [{ number: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        number: true,
        locationName: true,
        createdByName: true,
        createdAt: true,
        count: { select: { number: true } },
        decision: { select: { outcome: true, decidedByName: true, createdAt: true } },
        lines: { orderBy: { lineNumber: "asc" }, take: 3, select: { productName: true } },
        _count: { select: { lines: true } },
      },
    }),
  ]);
  return {
    waiting,
    canRecord: can(context, "stock.adjust.request"),
    canDecide: can(context, "stock.adjust.approve"),
    adjustments: rows.map((row) => ({
      id: row.id,
      number: row.number,
      locationName: row.locationName,
      status: statusOf(row.decision),
      lineCount: row._count.lines,
      products: row.lines.map((line) => line.productName),
      countNumber: row.count?.number ?? null,
      createdByName: row.createdByName,
      createdAt: row.createdAt,
      decidedByName: row.decision?.decidedByName ?? null,
      decidedAt: row.decision?.createdAt ?? null,
    })),
    ...paged(total, page),
  };
}

export type AdjustmentDetail = Omit<AdjustmentSummary, "products"> & {
  note: string | null;
  decisionNote: string | null;
  count: { id: string; number: number } | null;
  /** True when this person may approve or reject it now. */
  canDecide: boolean;
  lines: {
    lineNumber: number;
    productId: string;
    productName: string;
    unitName: string;
    /** Signed, in the unit chosen and in base units. */
    quantity: string;
    baseQuantity: string;
    baseUnitName: string;
    reason: AdjustmentReasonValue;
    /** While waiting: how much is in the location now, in base units. Null once decided. */
    stockNow: string | null;
  }[];
};

export async function getAdjustment(context: AppContext, input: unknown): Promise<AdjustmentDetail> {
  authorize(context, "report.stock.view");
  const { adjustmentId } = parseInput(z.object({ adjustmentId: z.string().uuid("That adjustment could not be found.") }), input);
  const db = businessDb(context);

  const row = await db.stockAdjustment.findFirst({
    where: { id: adjustmentId },
    include: { lines: { orderBy: { lineNumber: "asc" } }, decision: true, count: { select: { id: true, number: true } } },
  });
  if (!row) throw new NotFoundError("That adjustment could not be found.");

  const productIds = [...new Set(row.lines.map((line) => line.productId))];
  const [baseUnits, balances] = await Promise.all([
    db.productUnit.findMany({ where: { productId: { in: productIds }, isBase: true }, select: { productId: true, name: true } }),
    row.decision
      ? []
      : db.stockBalance.findMany({
          where: { productId: { in: productIds }, locationId: row.locationId },
          select: { productId: true, quantity: true },
        }),
  ]);
  const baseUnitOf = new Map(baseUnits.map((unit) => [unit.productId, unit.name]));
  const stockOf = new Map(balances.map((balance) => [balance.productId, balance.quantity.toFixed(3)]));

  return {
    id: row.id,
    number: row.number,
    locationName: row.locationName,
    status: statusOf(row.decision),
    lineCount: row.lines.length,
    countNumber: row.count?.number ?? null,
    count: row.count,
    note: row.note,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    decidedByName: row.decision?.decidedByName ?? null,
    decidedAt: row.decision?.createdAt ?? null,
    decisionNote: row.decision?.note ?? null,
    canDecide: !row.decision && can(context, "stock.adjust.approve"),
    lines: row.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productId: line.productId,
      productName: line.productName,
      unitName: line.unitName,
      quantity: line.quantity.toFixed(3),
      baseQuantity: line.baseQuantity.toFixed(3),
      baseUnitName: baseUnitOf.get(line.productId) ?? "",
      reason: line.reason,
      stockNow: row.decision ? null : (stockOf.get(line.productId) ?? "0.000"),
    })),
  };
}
