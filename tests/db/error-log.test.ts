import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { recordError } from "@/server/error-log";
import { ForbiddenError } from "@/server/errors";
import { listErrors } from "@/server/platform/error-log";
import { createWorld, type World } from "../support/world";

/** The app's own error log (C68): what went wrong unexpectedly, for the owners to read. */

let world: World;

beforeEach(async () => {
  world = await createWorld();
});

describe("the error log", () => {
  it("keeps where it happened, who was signed in and the error's own message — and only owners read it", async () => {
    await recordError({ kind: "action", place: 'The action that ends with "Customer saved."', error: new TypeError("Cannot read properties of undefined (reading 'name')"), context: world.a.as.CASHIER });
    await recordError({ kind: "page", place: "GET /reports/sales", error: "a plain string was thrown", digest: "1234567890" });

    const list = await listErrors(world.ownerOutside);
    expect(list).toMatchObject({ total: 2, last24Hours: 2 });
    const byKind = Object.fromEntries(list.rows.map((row) => [row.kind, row]));
    expect(byKind.action).toMatchObject({
      place: 'The action that ends with "Customer saved."',
      message: "TypeError: Cannot read properties of undefined (reading 'name')",
      userName: "Test a.cashier",
      businessName: world.a.name,
      appVersion: "development",
      digest: null,
    });
    expect(byKind.action.detail).toMatch(/TypeError: Cannot read properties/);
    expect(byKind.page).toMatchObject({ place: "GET /reports/sales", message: "a plain string was thrown", detail: null, digest: "1234567890", userName: null, businessName: null });

    for (const role of ["ADMIN", "MANAGER", "ACCOUNTANT", "CASHIER", "STOREKEEPER"] as const) {
      await expect(listErrors(world.a.as[role]), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await listErrors(world.ownerInA)).total).toBe(2);
  });

  it("never fails itself, cuts very long text short, and clears entries older than 90 days", async () => {
    // Whatever is thrown, noting it must not throw.
    await expect(recordError({ kind: "request", place: "x".repeat(1000), error: new Error("y".repeat(5000)) })).resolves.toBeUndefined();
    await expect(recordError({ kind: "route", place: "", error: undefined })).resolves.toBeUndefined();
    await expect(recordError({ kind: "route", place: "odd", error: { toString: () => { throw new Error("cannot even be printed"); } } })).resolves.toBeUndefined();
    const db = getDb();
    const saved = await db.errorLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(saved.length).toBeGreaterThanOrEqual(2);
    const long = saved.find((row) => row.kind === "request")!;
    expect(long.place).toHaveLength(300);
    expect(long.message).toHaveLength(1000);

    await db.errorLog.create({ data: { kind: "page", place: "old", message: "from long ago", createdAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) } });
    await db.errorLog.create({ data: { kind: "page", place: "recent", message: "from last month", createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } });
    const list = await listErrors(world.ownerOutside);
    expect(list.rows.map((row) => row.place)).toContain("recent");
    expect(list.rows.map((row) => row.place)).not.toContain("old");
    expect(await db.errorLog.count({ where: { place: "old" } })).toBe(0);
    expect(list.last24Hours).toBe(list.total - 1);
  });
});
