import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { optionalText } from "@/server/input";
import { authorize } from "@/server/permissions";

/** The companies and people the business in use buys goods from. */

const FIX_FIELDS = "Please correct the highlighted fields.";
const NOT_FOUND = "That supplier could not be found.";

export type SupplierView = {
  id: string;
  name: string;
  phone: string | null;
  note: string | null;
  active: boolean;
  deliveries: number;
};

/** Every supplier, in name order, with how many deliveries each has made. */
export async function listSuppliers(context: AppContext): Promise<SupplierView[]> {
  authorize(context, "stock.receipts.view");
  const rows = await businessDb(context).supplier.findMany({
    orderBy: [{ deactivatedAt: "asc" }, { name: "asc" }],
    select: { id: true, name: true, phone: true, note: true, deactivatedAt: true, _count: { select: { goodsReceipts: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    note: row.note,
    active: row.deactivatedAt === null,
    deliveries: row._count.goodsReceipts,
  }));
}

const nameSchema = z
  .string()
  .trim()
  .min(2, "Enter the supplier's name (at least 2 characters).")
  .max(120, "The name is too long (120 characters at most).");
const detailsSchema = {
  name: nameSchema,
  phone: optionalText(40, "The phone number is too long (40 characters at most)."),
  note: optionalText(300, "The note is too long (300 characters at most)."),
};
const idSchema = z.string().uuid(NOT_FOUND);

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createSupplier(context: AppContext, input: unknown): Promise<{ id: string }> {
  authorize(context, "supplier.manage");
  const businessId = businessIdOf(context);
  const data = parseInput(z.object(detailsSchema), input);

  try {
    return await businessDb(context).$transaction(async (tx) => {
      const supplier = await tx.supplier.create({ data: { businessId, ...data } });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "supplier.created",
          summary: `${context.actor.name} added the supplier "${supplier.name}".`,
          targetType: "supplier",
          targetId: supplier.id,
        }),
      });
      return { id: supplier.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ValidationError(FIX_FIELDS, { name: "There is already a supplier with this name." });
    throw error;
  }
}

export async function updateSupplier(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "supplier.manage");
  const data = parseInput(z.object({ supplierId: idSchema, ...detailsSchema }), input);
  const db = businessDb(context);

  const supplier = await db.supplier.findFirst({ where: { id: data.supplierId } });
  if (!supplier) throw new NotFoundError(NOT_FOUND);
  if (supplier.name === data.name && supplier.phone === data.phone && supplier.note === data.note) return;

  try {
    await db.$transaction(async (tx) => {
      await tx.supplier.update({
        where: { id: supplier.id },
        data: { name: data.name, phone: data.phone, note: data.note },
      });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "supplier.updated",
          summary:
            supplier.name === data.name
              ? `${context.actor.name} changed the details of the supplier "${supplier.name}".`
              : `${context.actor.name} renamed the supplier "${supplier.name}" to "${data.name}".`,
          targetType: "supplier",
          targetId: supplier.id,
        }),
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ValidationError(FIX_FIELDS, { name: "There is already a supplier with this name." });
    throw error;
  }
}

/** Takes a supplier out of use, or brings it back. Suppliers are never deleted. */
export async function setSupplierActive(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "supplier.manage");
  const data = parseInput(z.object({ supplierId: idSchema, active: z.boolean() }), input);

  await businessDb(context).$transaction(async (tx) => {
    const supplier = await tx.supplier.findFirst({ where: { id: data.supplierId } });
    if (!supplier) throw new NotFoundError(NOT_FOUND);
    if ((supplier.deactivatedAt === null) === data.active) return;

    await tx.supplier.update({
      where: { id: supplier.id },
      data: { deactivatedAt: data.active ? null : new Date() },
    });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: data.active ? "supplier.reactivated" : "supplier.deactivated",
        summary: `${context.actor.name} ${data.active ? "brought back" : "took out of use"} the supplier "${supplier.name}".`,
        targetType: "supplier",
        targetId: supplier.id,
      }),
    });
  });
}
