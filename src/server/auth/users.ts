import "server-only";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { Prisma, type Role } from "@/generated/prisma/client";
import { ValidationError } from "@/server/errors";
import {
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  USERNAME_PATTERN,
  placeholderEmail,
} from "./config";

export const personNameSchema = z
  .string()
  .trim()
  .min(1, "Enter the person's name.")
  .max(80, "The name is too long (80 characters at most).");

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(MIN_USERNAME_LENGTH, `A username needs at least ${MIN_USERNAME_LENGTH} characters.`)
  .max(MAX_USERNAME_LENGTH, `A username can have at most ${MAX_USERNAME_LENGTH} characters.`)
  .regex(USERNAME_PATTERN, "Use only letters, numbers, dots and underscores in a username.");

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `A password needs at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH, `A password can have at most ${MAX_PASSWORD_LENGTH} characters.`);

/** Turns a failed Zod check into a ValidationError with one message per field. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = issue.path.join(".") || "form";
    fieldErrors[field] ??= issue.message;
  }
  throw new ValidationError("Please correct the highlighted fields.", fieldErrors);
}

/**
 * The rows for a new user and their password, in the shape the login library expects.
 * Pass the result as `data` to `user.create` (through the scoped client for staff).
 */
export async function newUserData(input: {
  name: string;
  username: string;
  password: string;
  role: Role;
}) {
  const id = randomUUID();
  return {
    id,
    name: input.name,
    username: input.username,
    displayUsername: input.username,
    email: placeholderEmail(input.username),
    role: input.role,
    accounts: {
      create: {
        id: randomUUID(),
        accountId: id,
        providerId: "credential",
        password: await hashPassword(input.password),
      },
    },
  };
}

export { hashPassword };

/** Usernames are unique across the whole system; report a clash in plain words. */
export function rethrowUsernameTaken(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new ValidationError("Please correct the highlighted fields.", {
      username: "That username is already taken. Choose another.",
    });
  }
  throw error;
}
