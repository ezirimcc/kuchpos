import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/decimal";
import { plainNumber, shopDayEnd, shopDayStart, transferNumber } from "@/lib/format";
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
 * Moving stock between the locations of the business in use (Storeroom ⇄ Shelf).
 *
 * One transfer document, and for every line two stock movements — out of one location, into
 * the other — saved together with both balance changes in one database transaction. The
 * business's total stock is never changed by a transfer, and neither is the average cost.
 * A saved transfer is never changed; a mistake is put right with a transfer the other way.
 */

const MAX_LINES = 200;
const MAX_UNIT_QUANTITY = new Decimal("9999999.999");
const MAX_BASE_QUANTITY = new Decimal("999999999.999");
/** How many times to try again when the database reports that two savers got in each other's way. */
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// What the "new transfer" screen needs
// ---------------------------------------------------------------------------

export type TransferProduct = {
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

export type TransferOptions = {
  locations: { id: string; name: string; kind: "SHELF" | "STOREROOM" }[];
  products: TransferProduct[];
};

export async function getTransferOptions(context: AppContext): Promise<TransferOptions> {
  authorize(context, "stock.transfer");
  const db = businessDb(context);
  const [locations, products] = await Promise.all([
    // Storeroom first: most transfers go from the Storeroom to the Shelf.
    db.location.findMany({ orderBy: { kind: "desc" }, select: { id: true, name: true, kind: true } }),
    db.product.findMany({
      // Only products that have stock somewhere can be moved.
      where: { deactivatedAt: null, stockBalances: { some: { quantity: { gt: 0 } } } },
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
    locations,
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      code: product.code,
      allowsFraction: product.allowsFraction,
      baseUnitName: product.units.find((unit) => unit.isBase)?.name ?? "",
      units: product.units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        factor: unit.factor.toFixed(3),
        isBase: unit.isBase,
      })),
      stock: Object.fromEntries(product.stockBalances.map((balance) => [balance.locationId, balance.quantity.toFixed(3)])),
    })),
  };
}

// ---------------------------------------------------------------------------
// Saving a transfer
// ---------------------------------------------------------------------------

const transferSchema = z.object({
  requestId: z.string().uuid("This form has expired. Reload the page and enter the transfer again."),
  fromLocationId: z.string().uuid("Choose where the goods are coming from."),
  toLocationId: z.string().uuid("Choose where the goods are going."),
  note: optionalText(300, "The note is too long (300 characters at most).").optional().default(""),
  lines: z
    .array(z.object({ productId: z.string().trim(), unitId: z.string().trim(), quantity: z.string().trim() }))
    .min(1, "Add at least one product to the transfer.")
    .max(MAX_LINES, `A transfer can have at most ${MAX_LINES} lines. Split it into two transfers.`),
});

export type TransferResult = { id: string; number: number; alreadySaved: boolean };

type CheckedLine = {
  index: number;
  productId: string;
  productUnitId: string;
  productName: string;
  unitName: string;
  unitFactor: string;
  quantity: string;
  baseQuantity: Decimal;
};

/**
 * Moves stock from one location to the other: the document, its lines, an "out" and an "in"
 * movement per line and both balances — all of it, or none of it.
 *
 * `requestId` is made up by the browser; sending the same one again returns the transfer
 * that was already saved and changes nothing. If a location does not hold enough of any
 * product, the whole transfer is refused.
 */
export async function transferStock(context: AppContext, input: unknown): Promise<TransferResult> {
  authorize(context, "stock.transfer");
  const businessId = businessIdOf(context);
  const data = parseInput(transferSchema, input);
  const db = businessDb(context);

  const alreadySaved = async (): Promise<TransferResult | null> => {
    const saved = await db.stockTransfer.findFirst({ where: { requestId: data.requestId }, select: { id: true, number: true } });
    return saved ? { ...saved, alreadySaved: true } : null;
  };
  const repeat = await alreadySaved();
  if (repeat) return repeat;

  const fieldErrors: Record<string, string> = {};

  // --- The two locations -----------------------------------------------------------
  const [from, to] = await Promise.all([
    db.location.findFirst({ where: { id: data.fromLocationId }, select: { id: true, name: true } }),
    db.location.findFirst({ where: { id: data.toLocationId }, select: { id: true, name: true } }),
  ]);
  if (!from) fieldErrors.fromLocationId = "Choose where the goods are coming from.";
  if (!to) fieldErrors.toLocationId = "Choose where the goods are going.";
  else if (from && from.id === to.id) fieldErrors.toLocationId = "Choose a different location from the one the goods are leaving.";

  // --- The lines -------------------------------------------------------------------
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

  const checked: CheckedLine[] = [];
  data.lines.forEach((line, index) => {
    const at = (field: string) => `lines.${index}.${field}`;
    const product = productById.get(line.productId);
    if (!product) {
      fieldErrors[at("productId")] = "Choose a product.";
      return;
    }
    if (product.deactivatedAt) {
      fieldErrors[at("productId")] = `"${product.name}" is out of use. Bring it back first if its stock must be moved.`;
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
      checked.push({
        index,
        productId: product.id,
        productUnitId: unit.id,
        productName: product.name,
        unitName: unit.name,
        unitFactor: unit.factor.toFixed(3),
        quantity: quantityToString(quantity),
        baseQuantity,
      });
    } catch {
      fieldErrors[at("quantity")] = "Enter how many to move, as a number greater than zero (up to 3 decimal places).";
    }
  });

  if (Object.keys(fieldErrors).length > 0 || !from || !to) {
    throw new ValidationError("Nothing was moved. Please correct the highlighted fields.", fieldErrors);
  }

  // What each product loses from one location and gains in the other, in base units.
  const perProduct = new Map<string, Decimal>();
  for (const line of checked) {
    perProduct.set(line.productId, (perProduct.get(line.productId) ?? new Decimal(0)).plus(line.baseQuantity));
  }
  // Always in the same order, so two people saving at the same moment cannot block each other.
  const productOrder = [...perProduct.keys()].sort();
  const baseUnitOf = (productId: string) => productById.get(productId)?.units.find((unit) => unit.isBase)?.name ?? "";

  const save = () =>
    db.$transaction(
      async (tx) => {
        const number = await takeDocumentNumber(tx, businessId, "STOCK_TRANSFER");
        // Each product's "turn" is taken before anything that refers to the product is written
        // (see receiveGoods for why).
        for (const productId of productOrder) {
          await tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() }, select: { id: true } });
        }

        const transfer = await tx.stockTransfer.create({
          data: {
            businessId,
            requestId: data.requestId,
            number,
            fromLocationId: from.id,
            fromLocationName: from.name,
            toLocationId: to.id,
            toLocationName: to.name,
            note: data.note || null,
            createdByUserId: context.actor.userId,
            createdByName: context.actor.name,
          },
        });
        await tx.stockTransferLine.createMany({
          data: checked.map((line, position) => ({
            businessId,
            transferId: transfer.id,
            lineNumber: position + 1,
            productId: line.productId,
            productUnitId: line.productUnitId,
            productName: line.productName,
            unitName: line.unitName,
            unitFactor: line.unitFactor,
            quantity: line.quantity,
            baseQuantity: quantityToString(line.baseQuantity),
          })),
        });

        const short: Record<string, string> = {};
        for (const productId of productOrder) {
          const moving = quantityToString(perProduct.get(productId)!);
          // The product's "turn", as for deliveries: everything that changes this product's
          // stock passes through here one at a time.
          await tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() }, select: { id: true } });

          // Taken out only if that much is there — one statement, so two transfers can never
          // both take the last of it.
          const lowered = await tx.stockBalance.updateMany({
            where: { productId, locationId: from.id, quantity: { gte: moving } },
            data: { quantity: { decrement: moving } },
          });
          if (lowered.count !== 1) {
            const there = await tx.stockBalance.findFirst({ where: { productId, locationId: from.id }, select: { quantity: true } });
            const unit = baseUnitOf(productId);
            const message =
              `Only ${plainNumber(there?.quantity.toFixed(3) ?? "0")} ${unit} of "${productById.get(productId)!.name}" ` +
              `is in ${from.name}. You asked to move ${plainNumber(moving)} ${unit}.`;
            for (const line of checked) if (line.productId === productId) short[`lines.${line.index}.quantity`] = message;
            continue;
          }
          const raised = await tx.stockBalance.updateMany({
            where: { productId, locationId: to.id },
            data: { quantity: { increment: moving } },
          });
          if (raised.count === 0) {
            await tx.stockBalance.create({ data: { businessId, productId, locationId: to.id, quantity: moving } });
          }
        }
        // Throwing here undoes everything above, including the lines that did have enough.
        if (Object.keys(short).length > 0) {
          throw new ValidationError(`Nothing was moved: there is not enough in ${from.name}.`, short);
        }

        const movement = (line: CheckedLine, type: "TRANSFER_OUT" | "TRANSFER_IN") => {
          const sign = type === "TRANSFER_OUT" ? "-" : "";
          return {
            businessId,
            productId: line.productId,
            locationId: type === "TRANSFER_OUT" ? from.id : to.id,
            type,
            quantityDelta: `${sign}${quantityToString(line.baseQuantity)}`,
            unitName: line.unitName,
            unitFactor: line.unitFactor,
            unitQuantity: `${sign}${line.quantity}`,
            documentType: "stock_transfer",
            documentId: transfer.id,
            documentNumber: transferNumber(number),
            userId: context.actor.userId,
            userName: context.actor.name,
          };
        };
        await tx.stockMovement.createMany({
          data: checked.flatMap((line) => [movement(line, "TRANSFER_OUT"), movement(line, "TRANSFER_IN")]),
        });

        await tx.activityLog.create({
          data: activityRow(context, {
            action: "stock.transferred",
            summary:
              `${context.actor.name} moved stock from ${from.name} to ${to.name} (transfer ${transferNumber(number)}): ` +
              checked
                .slice(0, 5)
                .map((line) => `${plainNumber(line.quantity)} ${line.unitName} of ${line.productName}`)
                .join(", ") +
              (checked.length > 5 ? ` and ${checked.length - 5} more` : "") +
              ".",
            targetType: "stock_transfer",
            targetId: transfer.id,
            details: { number, from: from.name, to: to.name, lines: checked.length },
          }),
        });

        return { id: transfer.id, number, alreadySaved: false };
      },
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );

  for (let attempt = 1; ; attempt++) {
    try {
      return await save();
    } catch (error) {
      const known = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null;
      // The same submission arrived twice at the same moment: return the one that was saved.
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
// Transfers: list and detail
// ---------------------------------------------------------------------------

export type TransferSummary = {
  id: string;
  number: number;
  fromLocationName: string;
  toLocationName: string;
  lineCount: number;
  /** The first few products, for recognising the transfer in the list. */
  products: string[];
  createdByName: string;
  createdAt: Date;
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

/** One page of transfers, newest first. Filter by product, person or transfer number, or by the days they were made. */
export async function listTransfers(
  context: AppContext,
  input: unknown = {},
): Promise<{ transfers: TransferSummary[]; canTransfer: boolean } & Paged> {
  authorize(context, "report.stock.view");
  const { search, from, to, page } = parseInput(listSchema, input);

  const createdAt: Prisma.DateTimeFilter = {};
  if (from) createdAt.gte = shopDayStart(from)!;
  if (to) createdAt.lte = shopDayEnd(to)!;
  const numberSearch = /^(?:tr-?)?0*(\d{1,9})$/i.exec(search)?.[1];

  const where: Prisma.StockTransferWhereInput = {
    ...(from || to ? { createdAt } : {}),
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
  const [total, rows] = await Promise.all([
    db.stockTransfer.count({ where }),
    db.stockTransfer.findMany({
      where,
      orderBy: [{ number: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        number: true,
        fromLocationName: true,
        toLocationName: true,
        createdByName: true,
        createdAt: true,
        lines: { orderBy: { lineNumber: "asc" }, take: 3, select: { productName: true } },
        _count: { select: { lines: true } },
      },
    }),
  ]);
  return {
    canTransfer: can(context, "stock.transfer"),
    transfers: rows.map((row) => ({
      id: row.id,
      number: row.number,
      fromLocationName: row.fromLocationName,
      toLocationName: row.toLocationName,
      lineCount: row._count.lines,
      products: row.lines.map((line) => line.productName),
      createdByName: row.createdByName,
      createdAt: row.createdAt,
    })),
    ...paged(total, page),
  };
}

export type TransferDetail = Omit<TransferSummary, "products"> & {
  note: string | null;
  lines: {
    lineNumber: number;
    productId: string;
    productName: string;
    unitName: string;
    unitFactor: string;
    quantity: string;
    baseQuantity: string;
  }[];
};

export async function getTransfer(context: AppContext, input: unknown): Promise<TransferDetail> {
  authorize(context, "report.stock.view");
  const { transferId } = parseInput(z.object({ transferId: z.string().uuid("That transfer could not be found.") }), input);

  const row = await businessDb(context).stockTransfer.findFirst({
    where: { id: transferId },
    include: { lines: { orderBy: { lineNumber: "asc" } } },
  });
  if (!row) throw new NotFoundError("That transfer could not be found.");
  return {
    id: row.id,
    number: row.number,
    fromLocationName: row.fromLocationName,
    toLocationName: row.toLocationName,
    lineCount: row.lines.length,
    note: row.note,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    lines: row.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productId: line.productId,
      productName: line.productName,
      unitName: line.unitName,
      unitFactor: line.unitFactor.toFixed(3),
      quantity: line.quantity.toFixed(3),
      baseQuantity: line.baseQuantity.toFixed(3),
    })),
  };
}
