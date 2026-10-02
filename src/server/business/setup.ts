import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { activityRow } from "@/server/activity";
import type { AppContext } from "@/server/auth/context";
import { parseInput } from "@/server/auth/users";
import { businessDb, businessIdOf } from "@/server/db/scoped";
import { NotFoundError, ValidationError } from "@/server/errors";
import { authorize } from "@/server/permissions";

/** Stock locations and checkout terminals of the business in use. */

const FIX_FIELDS = "Please correct the highlighted fields.";

export type LocationView = { id: string; name: string; kind: "SHELF" | "STOREROOM" };
export type TerminalView = {
  id: string;
  code: string;
  name: string;
  paperWidth: "MM58" | "MM80";
  active: boolean;
};

export async function getSetup(
  context: AppContext,
): Promise<{ locations: LocationView[]; terminals: TerminalView[] }> {
  authorize(context, "setup.manage");
  const db = businessDb(context);
  const [locations, terminals] = await Promise.all([
    db.location.findMany({ orderBy: { kind: "asc" }, select: { id: true, name: true, kind: true } }),
    db.terminal.findMany({
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, paperWidth: true, deactivatedAt: true },
    }),
  ]);
  return {
    locations,
    terminals: terminals.map((terminal) => ({
      id: terminal.id,
      code: terminal.code,
      name: terminal.name,
      paperWidth: terminal.paperWidth,
      active: terminal.deactivatedAt === null,
    })),
  };
}

const nameSchema = z
  .string()
  .trim()
  .min(2, "Enter a name (at least 2 characters).")
  .max(60, "The name is too long (60 characters at most).");

const renameLocationSchema = z.object({
  locationId: z.string().uuid("That location could not be found."),
  name: nameSchema,
});

export async function renameLocation(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "setup.manage");
  const data = parseInput(renameLocationSchema, input);
  const db = businessDb(context);

  const location = await db.location.findFirst({ where: { id: data.locationId } });
  if (!location) throw new NotFoundError("That location could not be found.");
  if (location.name === data.name) return;

  try {
    await db.$transaction(async (tx) => {
      await tx.location.update({ where: { id: location.id }, data: { name: data.name } });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "location.renamed",
          summary: `${context.actor.name} renamed the location "${location.name}" to "${data.name}".`,
          targetType: "location",
          targetId: location.id,
        }),
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ValidationError(FIX_FIELDS, { name: "Another location already has this name." });
    }
    throw error;
  }
}

const paperWidthSchema = z.enum(["MM58", "MM80"], { error: "Choose the receipt paper width." });
const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,6}$/, "Use 1 to 6 capital letters or numbers, for example T2.");

const createTerminalSchema = z.object({ code: codeSchema, name: nameSchema, paperWidth: paperWidthSchema });

/** Registers a checkout computer. Its code starts every receipt number and can never be changed. */
export async function createTerminal(context: AppContext, input: unknown): Promise<{ id: string }> {
  authorize(context, "setup.manage");
  const businessId = businessIdOf(context);
  const data = parseInput(createTerminalSchema, input);

  try {
    return await businessDb(context).$transaction(async (tx) => {
      const terminal = await tx.terminal.create({ data: { businessId, ...data } });
      await tx.activityLog.create({
        data: activityRow(context, {
          action: "terminal.created",
          summary: `${context.actor.name} added the checkout terminal "${terminal.code}" (${terminal.name}).`,
          targetType: "terminal",
          targetId: terminal.id,
        }),
      });
      return { id: terminal.id };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ValidationError(FIX_FIELDS, { code: "This business already has a terminal with that code." });
    }
    throw error;
  }
}

const updateTerminalSchema = z.object({
  terminalId: z.string().uuid("That terminal could not be found."),
  name: nameSchema,
  paperWidth: paperWidthSchema,
});

export async function updateTerminal(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "setup.manage");
  const data = parseInput(updateTerminalSchema, input);

  await businessDb(context).$transaction(async (tx) => {
    const terminal = await tx.terminal.findFirst({ where: { id: data.terminalId } });
    if (!terminal) throw new NotFoundError("That terminal could not be found.");
    if (terminal.name === data.name && terminal.paperWidth === data.paperWidth) return;

    await tx.terminal.update({
      where: { id: terminal.id },
      data: { name: data.name, paperWidth: data.paperWidth },
    });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: "terminal.updated",
        summary: `${context.actor.name} changed the terminal "${terminal.code}": name "${data.name}", paper ${data.paperWidth === "MM58" ? "58 mm" : "80 mm"}.`,
        targetType: "terminal",
        targetId: terminal.id,
      }),
    });
  });
}

const setTerminalActiveSchema = z.object({
  terminalId: z.string().uuid("That terminal could not be found."),
  active: z.boolean(),
});

/** Takes a terminal out of use, or brings it back. Terminals are never deleted. */
export async function setTerminalActive(context: AppContext, input: unknown): Promise<void> {
  authorize(context, "setup.manage");
  const data = parseInput(setTerminalActiveSchema, input);

  await businessDb(context).$transaction(async (tx) => {
    const terminal = await tx.terminal.findFirst({ where: { id: data.terminalId } });
    if (!terminal) throw new NotFoundError("That terminal could not be found.");
    if ((terminal.deactivatedAt === null) === data.active) return;

    await tx.terminal.update({
      where: { id: terminal.id },
      data: { deactivatedAt: data.active ? null : new Date() },
    });
    await tx.activityLog.create({
      data: activityRow(context, {
        action: data.active ? "terminal.reactivated" : "terminal.deactivated",
        summary: `${context.actor.name} ${data.active ? "brought back" : "took out of use"} the terminal "${terminal.code}".`,
        targetType: "terminal",
        targetId: terminal.id,
      }),
    });
  });
}
