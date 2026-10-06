import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { dateToDay, dayToDate, formatDay, plainNumber, receiptNumber, shopToday } from "@/lib/format";
import { correctedAverageCost, formatNaira, moneyToString, sumMoney } from "@/lib/money";
import { quantityToString } from "@/lib/quantity";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { optionalText } from "@/server/input";
import { authorize } from "@/server/permissions";
import { type CheckedLine, checkLines, lineSchema, MAX_LINES, type SavedLine } from "@/server/receipt-lines";
import type { ReceivingOptions } from "./stock";

/**
 * Correcting a saved delivery without losing anything.
 *
 * What is the truth about stock: `stock_movement` (the add-only history) and `stock_balance`
 * (the running total, always equal to the sum of the movements). A delivery document is the
 * paperwork that explains some of those movements.
 *
 * So a correction never rewrites a movement. It
 *   1. keeps a complete, unchangeable snapshot of the delivery after the correction
 *      (`goods_receipt_version`; version 1 is the delivery as first saved),
 *   2. records every changed field with its old and new value (`goods_receipt_change`),
 *   3. writes NEW stock movements for the difference, and moves the balances by the same amount,
 *   4. brings the delivery document up to date and raises its version number,
 * all in one database transaction: every part is saved, or none is.
 */

const MAX_BACKDATE_DAYS = 366;

const STALE =
  "Someone else corrected this delivery while you were working, so nothing was saved. " +
  "Reload the page to see the delivery as it is now, then make your correction again.";

/** The delivery was no longer at the version the person was looking at when its turn came. */
class MovedOn extends Error {}

/** How many times to try again when the database reports that two savers got in each other's way. */
const MAX_ATTEMPTS = 3;

const receiptIdSchema = z.object({ receiptId: z.string().uuid("That delivery could not be found.") });

const correctionLineSchema = lineSchema.extend({
  /** The line's number on the saved delivery. Empty for a line that is being added. */
  lineNumber: z.number().int().positive().nullable().optional().default(null),
});

const correctSchema = z.object({
  receiptId: z.string().uuid("That delivery could not be found."),
  requestId: z.string().uuid("This form has expired. Reload the page and make the correction again."),
  /** The version the person was looking at. If the delivery has moved on, nothing is saved. */
  expectedVersion: z.number().int().positive(),
  reason: z
    .string()
    .trim()
    .min(5, "Explain why this delivery is being corrected.")
    .max(300, "The reason is too long (300 characters at most)."),
  supplierId: z.string().uuid("Choose the supplier."),
  locationId: z.string().uuid("Choose where the goods went."),
  receivedOn: z.string().trim(),
  invoiceNumber: optionalText(60, "The invoice number is too long (60 characters at most).").optional().default(""),
  note: optionalText(300, "The note is too long (300 characters at most).").optional().default(""),
  lines: z
    .array(correctionLineSchema)
    .min(1, "A delivery must keep at least one line.")
    .max(MAX_LINES, `A delivery can have at most ${MAX_LINES} lines.`),
});

export type CorrectionResult = { id: string; number: number; version: number; alreadySaved: boolean };

type ChangeRow = {
  lineNumber: number | null;
  productName: string | null;
  field: string;
  label: string;
  oldValue: string | null;
  newValue: string | null;
};

type LineView = {
  productName: string;
  unitName: string;
  quantity: string;
  unitCost: string;
  batchNumber: string | null;
  expiryDate: Date | null;
};

const amountOf = (line: LineView) => `${plainNumber(line.quantity)} ${line.unitName}`;
const costOf = (line: LineView) => formatNaira(new Decimal(line.unitCost));
const expiryOf = (line: LineView) => (line.expiryDate ? formatDay(dateToDay(line.expiryDate)) : null);

function describeLine(line: LineView): string {
  return (
    `${amountOf(line)} of ${line.productName} at ${costOf(line)} each` +
    (line.batchNumber ? `, batch ${line.batchNumber}` : "") +
    (line.expiryDate ? `, expires ${expiryOf(line)}` : "")
  );
}

function daysBetween(earlier: string, later: string): number {
  return Math.round((dayToDate(later)!.getTime() - dayToDate(earlier)!.getTime()) / 86_400_000);
}

/**
 * Corrects a saved delivery. Admins, managers and owners only; a reason is required.
 *
 * `requestId` is made up by the browser: sending the same correction twice applies it once.
 * `expectedVersion` is the version the person was looking at: if someone else corrected the
 * delivery in the meantime, this correction is refused rather than laid over theirs.
 * If the correction would take more out of a location than is there now, it is refused.
 */
export async function correctReceipt(context: AppContext, input: unknown): Promise<CorrectionResult> {
  authorize(context, "stock.receipt.correct");
  const businessId = businessIdOf(context);
  const data = parseInput(correctSchema, input);
  const db = businessDb(context);

  const alreadySaved = async (): Promise<CorrectionResult | null> => {
    const saved = await db.goodsReceiptVersion.findFirst({
      where: { requestId: data.requestId, receiptId: data.receiptId },
      select: { version: true, receipt: { select: { id: true, number: true } } },
    });
    return saved ? { id: saved.receipt.id, number: saved.receipt.number, version: saved.version, alreadySaved: true } : null;
  };
  const repeat = await alreadySaved();
  if (repeat) return repeat;

  const receipt = await db.goodsReceipt.findFirst({
    where: { id: data.receiptId },
    include: { lines: { orderBy: { lineNumber: "asc" } } },
  });
  if (!receipt) throw new NotFoundError("That delivery could not be found.");
  if (receipt.version !== data.expectedVersion) throw new ValidationError(STALE);

  const fieldErrors: Record<string, string> = {};

  // --- The date --------------------------------------------------------------------
  const today = shopToday();
  const oldReceivedOn = dateToDay(receipt.receivedOn);
  const receivedDate = dayToDate(data.receivedOn);
  if (!receivedDate) {
    fieldErrors.receivedOn = "Enter a real date.";
  } else if (data.receivedOn !== oldReceivedOn) {
    if (data.receivedOn > today) fieldErrors.receivedOn = "A delivery cannot be dated in the future.";
    else if (daysBetween(data.receivedOn, today) > MAX_BACKDATE_DAYS) {
      fieldErrors.receivedOn = "That date is more than a year ago. Check the year.";
    }
  }

  // --- Supplier and location: what stays the same keeps the name it was saved with ----
  let supplier: { id: string; name: string } | null = { id: receipt.supplierId, name: receipt.supplierName };
  if (data.supplierId !== receipt.supplierId) {
    const found = await db.supplier.findFirst({
      where: { id: data.supplierId },
      select: { id: true, name: true, deactivatedAt: true },
    });
    if (!found) fieldErrors.supplierId = "Choose the supplier.";
    else if (found.deactivatedAt) fieldErrors.supplierId = "This supplier is out of use. Choose another, or bring it back first.";
    supplier = found;
  }
  let location: { id: string; name: string } | null = { id: receipt.locationId, name: receipt.locationName };
  if (data.locationId !== receipt.locationId) {
    location = await db.location.findFirst({ where: { id: data.locationId }, select: { id: true, name: true } });
    if (!location) fieldErrors.locationId = "Choose where the goods went.";
  }

  // --- The lines -------------------------------------------------------------------
  const oldByNumber = new Map(receipt.lines.map((line) => [line.lineNumber, line]));
  const seen = new Set<number>();
  data.lines.forEach((line, index) => {
    if (line.lineNumber === null) return;
    if (!oldByNumber.has(line.lineNumber) || seen.has(line.lineNumber)) {
      fieldErrors[`lines.${index}.productId`] = "This line is no longer on the delivery. Reload the page and try again.";
    }
    seen.add(line.lineNumber);
  });
  const savedLineFor = (index: number): SavedLine | undefined => {
    const old = oldByNumber.get(data.lines[index].lineNumber ?? -1);
    return old ? { ...old, unitFactor: old.unitFactor.toFixed(3) } : undefined;
  };
  const results = await checkLines(db, data.lines, fieldErrors, savedLineFor);

  if (Object.keys(fieldErrors).length > 0 || !supplier || !location || !receivedDate) {
    throw new ValidationError("Nothing was saved. Please correct the highlighted fields.", fieldErrors);
  }
  const checked = results as CheckedLine[];
  const newLocation = location;
  const newSupplier = supplier;

  // --- What changed, field by field ---------------------------------------------------
  const changes: ChangeRow[] = [];
  const header = (field: string, label: string, oldValue: string | null, newValue: string | null) => {
    if (oldValue !== newValue) changes.push({ lineNumber: null, productName: null, field, label, oldValue, newValue });
  };
  header("supplier", "Supplier", receipt.supplierName, newSupplier.id === receipt.supplierId ? receipt.supplierName : newSupplier.name);
  header("location", "Went into", receipt.locationName, newLocation.id === receipt.locationId ? receipt.locationName : newLocation.name);
  header("receivedOn", "Date received", formatDay(oldReceivedOn), formatDay(data.receivedOn));
  header("invoiceNumber", "Supplier's invoice", receipt.invoiceNumber, data.invoiceNumber || null);
  header("note", "Note", receipt.note, data.note || null);

  const kept: { lineNumber: number; line: CheckedLine }[] = [];
  const added: CheckedLine[] = [];
  checked.forEach((line, index) => {
    const lineNumber = data.lines[index].lineNumber;
    if (lineNumber === null) {
      added.push(line);
      return;
    }
    kept.push({ lineNumber, line });
    const old = oldByNumber.get(lineNumber)!;
    const before: LineView = { ...old, quantity: old.quantity.toFixed(3), unitCost: old.unitCost.toFixed(2) };
    const change = (field: string, label: string, oldValue: string | null, newValue: string | null) => {
      if (oldValue !== newValue) changes.push({ lineNumber, productName: old.productName, field, label, oldValue, newValue });
    };
    change("quantity", "Arrived", amountOf(before), amountOf(line));
    // A change of unit alone changes what "cost each" means, so it is shown with its unit.
    change("unitCost", "Cost each", `${costOf(before)} per ${before.unitName}`, `${costOf(line)} per ${line.unitName}`);
    change("batchNumber", "Batch", old.batchNumber, line.batchNumber);
    change("expiryDate", "Expires", expiryOf(before), expiryOf(line));
  });
  const keptNumbers = new Set(kept.map((entry) => entry.lineNumber));
  for (const old of receipt.lines) {
    if (keptNumbers.has(old.lineNumber)) continue;
    changes.push({
      lineNumber: old.lineNumber,
      productName: old.productName,
      field: "lineRemoved",
      label: "Line removed",
      oldValue: describeLine({ ...old, quantity: old.quantity.toFixed(3), unitCost: old.unitCost.toFixed(2) }),
      newValue: null,
    });
  }
  // Added lines are given their numbers inside the transaction; remembered here by position.
  const addedChangeAt = changes.length;

  const oldTotal = new Decimal(receipt.totalCost.toFixed(2));
  const totalCost = sumMoney(checked.map((line) => line.lineCost));

  if (changes.length === 0 && added.length === 0) {
    throw new ValidationError("Nothing was changed, so nothing was saved.");
  }

  // --- The effect on stock: what the delivery put in before, against what it should have ----
  type Sum = { oldQuantity: Decimal; oldCost: Decimal; newQuantity: Decimal; newCost: Decimal; name: string };
  const zero = new Decimal(0);
  const perProduct = new Map<string, Sum>();
  const perPlace = new Map<string, Map<string, Decimal>>();
  const move = (productId: string, locationId: string, quantity: Decimal) => {
    const places = perPlace.get(productId) ?? new Map<string, Decimal>();
    places.set(locationId, (places.get(locationId) ?? zero).plus(quantity));
    perPlace.set(productId, places);
  };
  const sumFor = (productId: string, name: string): Sum => {
    const sum = perProduct.get(productId) ?? { oldQuantity: zero, oldCost: zero, newQuantity: zero, newCost: zero, name };
    perProduct.set(productId, sum);
    return sum;
  };
  for (const old of receipt.lines) {
    const sum = sumFor(old.productId, old.productName);
    sum.oldQuantity = sum.oldQuantity.plus(old.baseQuantity.toFixed(3));
    sum.oldCost = sum.oldCost.plus(old.lineCost.toFixed(2));
    move(old.productId, receipt.locationId, new Decimal(old.baseQuantity.toFixed(3)).negated());
  }
  for (const line of checked) {
    const sum = sumFor(line.productId, line.productName);
    sum.newQuantity = sum.newQuantity.plus(line.baseQuantity);
    sum.newCost = sum.newCost.plus(line.lineCost);
    move(line.productId, newLocation.id, line.baseQuantity);
  }
  // Always in the same order (product, then location), so two savers cannot block each other.
  const productOrder = [...perProduct.keys()]
    .filter((productId) => {
      const sum = perProduct.get(productId)!;
      const moved = [...perPlace.get(productId)!.values()].some((quantity) => !quantity.isZero());
      return moved || !sum.oldCost.equals(sum.newCost);
    })
    .sort();
  const locationNames = new Map([
    [receipt.locationId, receipt.locationName],
    [newLocation.id, newLocation.name],
  ]);
  const baseUnits = new Map(
    (
      await db.productUnit.findMany({
        where: { productId: { in: productOrder }, isBase: true },
        select: { productId: true, name: true },
      })
    ).map((unit) => [unit.productId, unit.name]),
  );

  const version = receipt.version + 1;
  const correctionNumber = `${receiptNumber(receipt.number)}-C${version - 1}`;

  const save = () =>
    db.$transaction(
      async (tx) => {
        // Taking the delivery's "turn": only one correction of a delivery can pass this point,
        // and only if the delivery is still at the version the person was looking at.
        const claimed = await tx.goodsReceipt.updateMany({
          where: { id: receipt.id, version: receipt.version },
          data: {
            version: { increment: 1 },
            supplierId: newSupplier.id,
            supplierName: newSupplier.name,
            locationId: newLocation.id,
            locationName: newLocation.name,
            receivedOn: receivedDate,
            invoiceNumber: data.invoiceNumber || null,
            note: data.note || null,
            totalCost: moneyToString(totalCost),
          },
        });
        if (claimed.count !== 1) throw new MovedOn();

        // Line numbers are never reused, so "line 2" means the same line in every version.
        const highest = await tx.goodsReceiptVersionLine.aggregate({
          where: { version: { receiptId: receipt.id } },
          _max: { lineNumber: true },
        });
        let nextNumber = Math.max(highest._max.lineNumber ?? 0, ...receipt.lines.map((line) => line.lineNumber)) + 1;
        const numbered = [...kept, ...added.map((line) => ({ lineNumber: nextNumber++, line }))].sort(
          (a, b) => a.lineNumber - b.lineNumber,
        );
        const addedChanges: ChangeRow[] = numbered
          .filter((entry) => !keptNumbers.has(entry.lineNumber))
          .map((entry) => ({
            lineNumber: entry.lineNumber,
            productName: entry.line.productName,
            field: "lineAdded",
            label: "Line added",
            oldValue: null,
            newValue: describeLine(entry.line),
          }));
        const allChanges = [...changes.slice(0, addedChangeAt), ...addedChanges];
        if (!oldTotal.equals(totalCost)) {
          allChanges.push({
            lineNumber: null,
            productName: null,
            field: "totalCost",
            label: "Total cost",
            oldValue: formatNaira(oldTotal),
            newValue: formatNaira(totalCost),
          });
        }

        const lineRows = numbered.map(({ lineNumber, line }) => ({
          businessId,
          lineNumber,
          productId: line.productId,
          productUnitId: line.productUnitId,
          productName: line.productName,
          unitName: line.unitName,
          unitFactor: line.unitFactor,
          quantity: line.quantity,
          baseQuantity: quantityToString(line.baseQuantity),
          unitCost: line.unitCost,
          lineCost: moneyToString(line.lineCost),
          batchNumber: line.batchNumber,
          expiryDate: line.expiryDate,
        }));

        // The delivery document now says what is true: removed lines go, changed lines are
        // brought up to date where they are, added lines are new rows…
        const removedNumbers = receipt.lines.map((line) => line.lineNumber).filter((number) => !keptNumbers.has(number));
        if (removedNumbers.length > 0) {
          await tx.goodsReceiptLine.deleteMany({ where: { receiptId: receipt.id, lineNumber: { in: removedNumbers } } });
        }
        const changedNumbers = new Set(allChanges.map((change) => change.lineNumber));
        for (const row of lineRows) {
          if (!keptNumbers.has(row.lineNumber) || !changedNumbers.has(row.lineNumber)) continue;
          await tx.goodsReceiptLine.update({
            where: { receiptId_lineNumber: { receiptId: receipt.id, lineNumber: row.lineNumber } },
            data: row,
          });
        }
        const addedRows = lineRows.filter((row) => !keptNumbers.has(row.lineNumber));
        if (addedRows.length > 0) {
          await tx.goodsReceiptLine.createMany({ data: addedRows.map((line) => ({ ...line, receiptId: receipt.id })) });
        }

        // …and this is the unchangeable record of that, with who, when, why and what changed.
        const snapshot = await tx.goodsReceiptVersion.create({
          data: {
            businessId,
            receiptId: receipt.id,
            version,
            requestId: data.requestId,
            reason: data.reason,
            supplierId: newSupplier.id,
            supplierName: newSupplier.name,
            locationId: newLocation.id,
            locationName: newLocation.name,
            receivedOn: receivedDate,
            invoiceNumber: data.invoiceNumber || null,
            note: data.note || null,
            totalCost: moneyToString(totalCost),
            createdByUserId: context.actor.userId,
            createdByName: context.actor.name,
          },
          select: { id: true },
        });
        await tx.goodsReceiptVersionLine.createMany({
          data: lineRows.map((line) => ({ ...line, versionId: snapshot.id })),
        });
        await tx.goodsReceiptChange.createMany({
          data: allChanges.map((change, position) => ({
            businessId,
            receiptId: receipt.id,
            versionId: snapshot.id,
            position,
            ...change,
          })),
        });

        // Stock: new movements for the difference. Past movements are left exactly as they are.
        const movements: Prisma.StockMovementCreateManyInput[] = [];
        for (const productId of productOrder) {
          const sum = perProduct.get(productId)!;
          // Touching the product row makes any other delivery or correction of it wait its turn.
          const product = await tx.product.update({
            where: { id: productId },
            data: { updatedAt: new Date() },
            select: { averageCost: true },
          });
          const before = await tx.stockBalance.aggregate({ where: { productId }, _sum: { quantity: true } });
          const average = correctedAverageCost({
            quantityNow: new Decimal(before._sum.quantity?.toFixed(3) ?? "0"),
            averageNow: new Decimal(product.averageCost.toFixed(4)),
            oldQuantity: sum.oldQuantity,
            oldCost: sum.oldCost,
            newQuantity: sum.newQuantity,
            newCost: sum.newCost,
          });
          await tx.product.update({ where: { id: productId }, data: { averageCost: average.toFixed(4) } });

          const places = [...perPlace.get(productId)!.entries()]
            .filter(([, quantity]) => !quantity.isZero())
            .sort(([a], [b]) => a.localeCompare(b));
          for (const [locationId, delta] of places) {
            if (delta.greaterThan(0)) {
              const raised = await tx.stockBalance.updateMany({
                where: { productId, locationId },
                data: { quantity: { increment: quantityToString(delta) } },
              });
              if (raised.count === 0) {
                await tx.stockBalance.create({ data: { businessId, productId, locationId, quantity: quantityToString(delta) } });
              }
            } else {
              // Taken away only if that much is still there — one statement, so two people
              // can never both take the last of it.
              const needed = delta.negated();
              const lowered = await tx.stockBalance.updateMany({
                where: { productId, locationId, quantity: { gte: quantityToString(needed) } },
                data: { quantity: { decrement: quantityToString(needed) } },
              });
              if (lowered.count !== 1) {
                const there = await tx.stockBalance.findFirst({ where: { productId, locationId }, select: { quantity: true } });
                const unit = baseUnits.get(productId) ?? "";
                throw new ValidationError(
                  `Nothing was saved. This correction would take ${plainNumber(quantityToString(needed))} ${unit} of ` +
                    `"${sum.name}" out of ${locationNames.get(locationId)}, but only ` +
                    `${plainNumber(there?.quantity.toFixed(3) ?? "0")} ${unit} is there now. ` +
                    "The rest has already been sold or moved, so the delivery cannot be reduced that far.",
                );
              }
            }
            movements.push({
              businessId,
              productId,
              locationId,
              type: "RECEIPT_CORRECTION",
              quantityDelta: quantityToString(delta),
              unitName: baseUnits.get(productId) ?? "",
              unitFactor: "1",
              unitQuantity: quantityToString(delta),
              documentType: "goods_receipt_correction",
              documentId: snapshot.id,
              documentNumber: correctionNumber,
              userId: context.actor.userId,
              userName: context.actor.name,
            });
          }
        }
        if (movements.length > 0) await tx.stockMovement.createMany({ data: movements });

        await tx.activityLog.create({
          data: activityRow(context, {
            action: "stock.receipt_corrected",
            summary:
              `${context.actor.name} corrected delivery ${receiptNumber(receipt.number)} (now version ${version}): ` +
              `${allChanges.length} change${allChanges.length === 1 ? "" : "s"}` +
              (movements.length > 0 ? `, stock adjusted in ${movements.length} place${movements.length === 1 ? "" : "s"}` : ", no effect on stock") +
              `. Reason: ${data.reason}`,
            targetType: "goods_receipt",
            targetId: receipt.id,
            details: {
              number: receipt.number,
              version,
              reason: data.reason,
              changes: allChanges.slice(0, 60).map((change) => ({
                line: change.lineNumber,
                what: change.label,
                was: change.oldValue,
                now: change.newValue,
              })),
              stock: movements.map((movement) => ({
                productId: movement.productId,
                locationId: movement.locationId,
                change: String(movement.quantityDelta),
              })),
            },
          }),
        });

        return { id: receipt.id, number: receipt.number, version, alreadySaved: false };
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );

  for (let attempt = 1; ; attempt++) {
    try {
      return await save();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
      // The same correction arrived twice at the same moment: report the one that was saved.
      if (error instanceof MovedOn || known === "P2002") {
        const saved = await alreadySaved();
        if (saved) return saved;
        if (error instanceof MovedOn) throw new ValidationError(STALE);
      }
      // Two savers blocked each other and the database undid this one completely: try again.
      if (known === "P2034" && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// What the "correct this delivery" screen needs
// ---------------------------------------------------------------------------

export type CorrectionOptions = ReceivingOptions & {
  receipt: {
    id: string;
    number: number;
    version: number;
    supplierId: string;
    locationId: string;
    receivedOn: string;
    invoiceNumber: string;
    note: string;
    lines: {
      lineNumber: number;
      productId: string;
      productName: string;
      unitId: string;
      quantity: string;
      unitCost: string;
      batchNumber: string;
      expiryDate: string;
    }[];
  };
};

export async function getCorrectionOptions(context: AppContext, input: unknown): Promise<CorrectionOptions> {
  authorize(context, "stock.receipt.correct");
  const { receiptId } = parseInput(receiptIdSchema, input);
  const db = businessDb(context);

  const receipt = await db.goodsReceipt.findFirst({
    where: { id: receiptId },
    include: { lines: { orderBy: { lineNumber: "asc" } } },
  });
  if (!receipt) throw new NotFoundError("That delivery could not be found.");
  const lineProducts = [...new Set(receipt.lines.map((line) => line.productId))];
  const lineUnits = [...new Set(receipt.lines.map((line) => line.productUnitId))];

  // Everything that can be chosen today, plus whatever this delivery already uses
  // (a supplier, product or unit that has since been taken out of use).
  const [suppliers, locations, products, baseUnits] = await Promise.all([
    db.supplier.findMany({
      where: { OR: [{ deactivatedAt: null }, { id: receipt.supplierId }] },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.location.findMany({ orderBy: { kind: "desc" }, select: { id: true, name: true, kind: true } }),
    db.product.findMany({
      where: { OR: [{ deactivatedAt: null }, { id: { in: lineProducts } }] },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        code: true,
        allowsFraction: true,
        tracksBatch: true,
        tracksExpiry: true,
        units: {
          where: { OR: [{ retiredAt: null, forPurchase: true }, { id: { in: lineUnits } }] },
          orderBy: { factor: "asc" },
          select: { id: true, name: true, factor: true, isBase: true },
        },
      },
    }),
    db.productUnit.findMany({ where: { isBase: true }, select: { productId: true, name: true } }),
  ]);
  const baseNames = new Map(baseUnits.map((unit) => [unit.productId, unit.name]));

  return {
    today: shopToday(),
    canBackdate: true,
    suppliers,
    locations,
    products: products
      .filter((product) => product.units.length > 0)
      .map((product) => ({
        id: product.id,
        name: product.name,
        code: product.code,
        allowsFraction: product.allowsFraction,
        tracksBatch: product.tracksBatch,
        tracksExpiry: product.tracksExpiry,
        baseUnitName: baseNames.get(product.id) ?? "",
        units: product.units.map((unit) => ({
          id: unit.id,
          name: unit.name,
          factor: unit.factor.toFixed(3),
          isBase: unit.isBase,
        })),
      })),
    receipt: {
      id: receipt.id,
      number: receipt.number,
      version: receipt.version,
      supplierId: receipt.supplierId,
      locationId: receipt.locationId,
      receivedOn: dateToDay(receipt.receivedOn),
      invoiceNumber: receipt.invoiceNumber ?? "",
      note: receipt.note ?? "",
      lines: receipt.lines.map((line) => ({
        lineNumber: line.lineNumber,
        productId: line.productId,
        productName: line.productName,
        unitId: line.productUnitId,
        quantity: plainNumber(line.quantity.toFixed(3)),
        unitCost: line.unitCost.toFixed(2),
        batchNumber: line.batchNumber ?? "",
        expiryDate: line.expiryDate ? dateToDay(line.expiryDate) : "",
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// The history of a delivery: every version, and what each correction changed
// ---------------------------------------------------------------------------

export type ReceiptVersionView = {
  version: number;
  /** Why the correction was made; empty for version 1, the delivery as first saved. */
  reason: string | null;
  savedByName: string;
  savedAt: Date;
  supplierName: string;
  locationName: string;
  receivedOn: string;
  invoiceNumber: string | null;
  note: string | null;
  totalCost: string;
  lines: {
    lineNumber: number;
    productName: string;
    unitName: string;
    quantity: string;
    baseQuantity: string;
    unitCost: string;
    lineCost: string;
    batchNumber: string | null;
    expiryDate: string | null;
  }[];
  /** Field-by-field differences from the version before. Empty for version 1. */
  changes: { lineNumber: number | null; productName: string | null; label: string; oldValue: string | null; newValue: string | null }[];
  /** The stock movements this correction wrote, in base units (negative means taken out). */
  stockEffects: { productName: string; locationName: string; quantity: string; unitName: string }[];
};

/** Every version of a delivery, oldest first. Anyone who may see deliveries may see their history. */
export async function getReceiptHistory(context: AppContext, input: unknown): Promise<ReceiptVersionView[]> {
  authorize(context, "stock.receipts.view");
  const { receiptId } = parseInput(receiptIdSchema, input);
  const db = businessDb(context);

  const receipt = await db.goodsReceipt.findFirst({ where: { id: receiptId }, select: { id: true } });
  if (!receipt) throw new NotFoundError("That delivery could not be found.");

  const versions = await db.goodsReceiptVersion.findMany({
    where: { receiptId },
    orderBy: { version: "asc" },
    include: { lines: { orderBy: { lineNumber: "asc" } }, changes: { orderBy: { position: "asc" } } },
  });
  const movements = await db.stockMovement.findMany({
    where: { documentType: "goods_receipt_correction", documentId: { in: versions.map((version) => version.id) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      documentId: true,
      quantityDelta: true,
      unitName: true,
      product: { select: { name: true } },
      location: { select: { name: true } },
    },
  });

  return versions.map((version) => ({
    version: version.version,
    reason: version.reason,
    savedByName: version.createdByName,
    savedAt: version.createdAt,
    supplierName: version.supplierName,
    locationName: version.locationName,
    receivedOn: dateToDay(version.receivedOn),
    invoiceNumber: version.invoiceNumber,
    note: version.note,
    totalCost: version.totalCost.toFixed(2),
    lines: version.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productName: line.productName,
      unitName: line.unitName,
      quantity: line.quantity.toFixed(3),
      baseQuantity: line.baseQuantity.toFixed(3),
      unitCost: line.unitCost.toFixed(2),
      lineCost: line.lineCost.toFixed(2),
      batchNumber: line.batchNumber,
      expiryDate: line.expiryDate ? dateToDay(line.expiryDate) : null,
    })),
    changes: version.changes.map((change) => ({
      lineNumber: change.lineNumber,
      productName: change.productName,
      label: change.label,
      oldValue: change.oldValue,
      newValue: change.newValue,
    })),
    stockEffects: movements
      .filter((movement) => movement.documentId === version.id)
      .map((movement) => ({
        productName: movement.product.name,
        locationName: movement.location.name,
        quantity: movement.quantityDelta.toFixed(3),
        unitName: movement.unitName,
      })),
  }));
}
