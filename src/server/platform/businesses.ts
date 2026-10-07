import "server-only";
import { z } from "zod";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import {
  newUserData,
  parseInput,
  passwordSchema,
  personNameSchema,
  usernameSchema,
} from "@/server/auth/users";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/server/db/client";
import { NotFoundError, ValidationError } from "@/server/errors";
import { authorize } from "@/server/permissions";
import { defaultLocations, defaultPaymentMethod, defaultTerminal } from "@/server/business/defaults";

/**
 * Owner-only operations that reach across businesses.
 * This folder is the only place (besides the login code) that uses the unscoped database client.
 */

const businessNameSchema = z
  .string()
  .trim()
  .min(2, "Enter the business name (at least 2 characters).")
  .max(80, "The business name is too long (80 characters at most).");

const idSchema = z.string().uuid("That business could not be found.");

/** Two names that differ only in capitals or spacing count as the same name. */
function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export type BusinessSummary = {
  id: string;
  name: string;
  active: boolean;
  staffCount: number;
  createdAt: Date;
};

export async function listBusinesses(context: AppContext): Promise<BusinessSummary[]> {
  authorize(context, "business.manage");
  const rows = await getDb().business.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      deactivatedAt: true,
      createdAt: true,
      _count: { select: { users: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    active: row.deactivatedAt === null,
    staffCount: row._count.users,
    createdAt: row.createdAt,
  }));
}

const createBusinessSchema = z.object({
  name: businessNameSchema,
  adminName: personNameSchema,
  adminUsername: usernameSchema,
  adminPassword: passwordSchema,
});

/** Creates a business together with its first admin — both, or neither. */
export async function createBusiness(context: AppContext, input: unknown): Promise<{ id: string }> {
  authorize(context, "business.manage");
  const data = parseInput(createBusinessSchema, input);
  const adminRow = await newUserData({
    name: data.adminName,
    username: data.adminUsername,
    password: data.adminPassword,
    role: "ADMIN",
  });

  const db = getDb();
  const nameTaken = await db.business.findUnique({ where: { nameKey: nameKey(data.name) } });
  if (nameTaken) {
    throw new ValidationError("Please correct the highlighted fields.", {
      name: "A business with this name already exists.",
    });
  }
  const usernameTaken = await db.user.findUnique({ where: { username: data.adminUsername } });
  if (usernameTaken) {
    throw new ValidationError("Please correct the highlighted fields.", {
      adminUsername: "That username is already taken. Choose another.",
    });
  }

  try {
    return await db.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: { name: data.name.replace(/\s+/g, " "), nameKey: nameKey(data.name) },
      });
      const admin = await tx.user.create({ data: { ...adminRow, businessId: business.id } });
      await tx.location.createMany({ data: defaultLocations(business.id) });
      await tx.terminal.create({ data: defaultTerminal(business.id) });
      await tx.paymentMethod.create({ data: defaultPaymentMethod(business.id) });
      await tx.activityLog.createMany({
        data: [
          {
            ...activityRow(context, {
              action: "business.created",
              summary: `${context.actor.name} created the business "${business.name}".`,
              targetType: "business",
              targetId: business.id,
            }),
            businessId: null,
          },
          {
            ...activityRow(context, {
              action: "staff.created",
              summary: `${context.actor.name} created the admin account "${admin.username}" for ${admin.name}.`,
              targetType: "user",
              targetId: admin.id,
            }),
            businessId: business.id,
          },
        ],
      });
      return { id: business.id };
    });
  } catch (error) {
    // Reached only if two requests raced past the checks above.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ValidationError(
        "A business with this name, or an account with this username, was created a moment ago. Nothing was saved this time.",
      );
    }
    throw error;
  }
}

const renameBusinessSchema = z.object({ businessId: idSchema, name: businessNameSchema });

export async function renameBusiness(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "business.manage");
  const data = parseInput(renameBusinessSchema, input);
  const db = getDb();

  const business = await db.business.findUnique({ where: { id: data.businessId } });
  if (!business) throw new NotFoundError("That business could not be found.");

  const key = nameKey(data.name);
  const clash = await db.business.findUnique({ where: { nameKey: key } });
  if (clash && clash.id !== business.id) {
    throw new ValidationError("Please correct the highlighted fields.", {
      name: "A business with this name already exists.",
    });
  }

  const newName = data.name.replace(/\s+/g, " ");
  await db.$transaction([
    db.business.update({ where: { id: business.id }, data: { name: newName, nameKey: key } }),
    db.activityLog.create({
      data: {
        ...activityRow(context, {
          action: "business.renamed",
          summary: `${context.actor.name} renamed the business from "${business.name}" to "${newName}".`,
          targetType: "business",
          targetId: business.id,
        }),
        businessId: business.id,
      },
    }),
  ]);
}

const setBusinessActiveSchema = z.object({ businessId: idSchema, active: z.boolean() });

/**
 * Deactivating a business signs out all its staff and stops anyone signing in to it.
 * Its records are kept, and it can be reactivated.
 */
export async function setBusinessActive(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "business.manage");
  const data = parseInput(setBusinessActiveSchema, input);
  const db = getDb();

  const business = await db.business.findUnique({ where: { id: data.businessId } });
  if (!business) throw new NotFoundError("That business could not be found.");
  if ((business.deactivatedAt === null) === data.active) return; // Already in the requested state.

  await db.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: business.id },
      data: { deactivatedAt: data.active ? null : new Date() },
    });
    if (!data.active) {
      await tx.session.deleteMany({ where: { user: { businessId: business.id } } });
      await tx.session.updateMany({
        where: { activeBusinessId: business.id },
        data: { activeBusinessId: null },
      });
    }
    await tx.activityLog.create({
      data: {
        ...activityRow(context, {
          action: data.active ? "business.reactivated" : "business.deactivated",
          summary: `${context.actor.name} ${data.active ? "reactivated" : "deactivated"} the business "${business.name}".`,
          targetType: "business",
          targetId: business.id,
        }),
        businessId: business.id,
      },
    });
  });
}

const openBusinessSchema = z.object({ businessId: idSchema });

/** An owner chooses which business to work in. Remembered on the server with their session. */
export async function openBusiness(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "business.open");
  const data = parseInput(openBusinessSchema, input);
  const db = getDb();

  const business = await db.business.findUnique({ where: { id: data.businessId } });
  if (!business) throw new NotFoundError("That business could not be found.");
  if (business.deactivatedAt) {
    throw new ValidationError("This business is deactivated. Reactivate it before opening it.");
  }

  await db.$transaction([
    db.session.update({
      where: { id: context.actor.sessionId },
      data: { activeBusinessId: business.id },
    }),
    db.activityLog.create({
      data: {
        ...activityRow(context, {
          action: "owner.opened_business",
          summary: `${context.actor.name} (owner) opened this business.`,
          targetType: "business",
          targetId: business.id,
        }),
        businessId: business.id,
      },
    }),
  ]);
}

/** The owner leaves the business they had open. */
export async function closeBusiness(context: AppContext): Promise<void> {
  authorize(context, "business.open");
  await getDb().session.update({
    where: { id: context.actor.sessionId },
    data: { activeBusinessId: null },
  });
}
