import { z } from "zod";

/** How many rows a list screen shows at a time. */
export const PAGE_SIZE = 50;

/** The page number sent by a list screen. Anything odd becomes page 1. */
export const pageNumber = z
  .union([z.number(), z.string()])
  .optional()
  .transform((value) => {
    const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "1", 10);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100_000 ? parsed : 1;
  });

export type Paged = { total: number; page: number; pageCount: number; pageSize: number };

export function paged(total: number, page: number): Paged {
  return { total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)), pageSize: PAGE_SIZE };
}
