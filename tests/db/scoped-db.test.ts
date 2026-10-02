import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/server/db/client";
import { createScopedDb } from "@/server/db/scoped";
import { createWorld, type World } from "../support/world";

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

describe("business-scoped database client", () => {
  it("lists only the rows of its own business", async () => {
    const users = await createScopedDb(world.a.id).user.findMany();
    expect(users).toHaveLength(5);
    expect(users.every((user) => user.businessId === world.a.id)).toBe(true);
  });

  it("never returns owners, who belong to no business", async () => {
    const found = await createScopedDb(world.a.id).user.findFirst({ where: { id: world.owner.id } });
    expect(found).toBeNull();
  });

  it("cannot read another business's record by its id", async () => {
    const db = createScopedDb(world.a.id);
    const theirs = world.b.staff.CASHIER.id;
    expect(await db.user.findFirst({ where: { id: theirs } })).toBeNull();
    expect(await db.user.findUnique({ where: { id: theirs } })).toBeNull();
    expect(await db.user.count({ where: { id: theirs } })).toBe(0);
  });

  it("cannot be widened with an OR condition", async () => {
    const found = await createScopedDb(world.a.id).user.findMany({
      where: { OR: [{ businessId: world.b.id }, { id: world.b.staff.ADMIN.id }] },
    });
    expect(found).toEqual([]);
  });

  it("cannot update or delete another business's record", async () => {
    const db = createScopedDb(world.a.id);
    const theirs = world.b.staff.CASHIER.id;

    await expect(db.user.update({ where: { id: theirs }, data: { name: "Hacked" } })).rejects.toThrow();
    expect((await db.user.updateMany({ where: { id: theirs }, data: { name: "Hacked" } })).count).toBe(0);
    await expect(db.user.delete({ where: { id: theirs } })).rejects.toThrow();
    expect((await db.user.deleteMany({ where: { id: theirs } })).count).toBe(0);

    const untouched = await getDb().user.findUnique({ where: { id: theirs } });
    expect(untouched?.name).toBe(world.b.staff.CASHIER.name);
  });

  it("stamps its own business on new rows, whatever the caller passes", async () => {
    const db = createScopedDb(world.a.id);
    const id = randomUUID();
    await db.user.create({
      data: {
        id,
        name: "New Person",
        username: "new.person",
        email: "new.person@users.kuchpos.invalid",
        role: "CASHIER",
        businessId: world.b.id, // An attempt to plant a row in another business.
      },
    });
    const created = await getDb().user.findUnique({ where: { id } });
    expect(created?.businessId).toBe(world.a.id);
  });

  it("limits sessions and passwords to people of its own business", async () => {
    const db = createScopedDb(world.a.id);
    expect((await db.session.deleteMany({ where: { userId: world.b.staff.ADMIN.id } })).count).toBe(0);
    expect(
      (await db.account.updateMany({ where: { userId: world.b.staff.ADMIN.id }, data: { password: "x" } })).count,
    ).toBe(0);
    expect(await getDb().session.count({ where: { userId: world.b.staff.ADMIN.id } })).toBe(1);
  });

  it("keeps the scope inside a transaction", async () => {
    const seen = await createScopedDb(world.a.id).$transaction(async (tx) => tx.user.count());
    expect(seen).toBe(5);
  });

  it("only shows its own business record", async () => {
    const businesses = await createScopedDb(world.a.id).business.findMany();
    expect(businesses.map((business) => business.id)).toEqual([world.a.id]);
  });

  it("refuses operations it cannot scope safely", async () => {
    const db = createScopedDb(world.a.id);
    await expect(
      db.user.upsert({ where: { id: "x" }, create: {} as never, update: {} }),
    ).rejects.toThrow(/not supported/);
    await expect(db.session.create({ data: {} as never })).rejects.toThrow(/cannot be created directly/);
    await expect(db.verification.findMany()).rejects.toThrow(/not tied to a business/);
  });

  it("refuses to be created without a business", () => {
    expect(() => createScopedDb("")).toThrow();
  });
});

describe("rules enforced by the database itself", () => {
  it("refuses changes to the activity log", async () => {
    const db = getDb();
    const entry = await db.activityLog.create({
      data: { actorName: "Test", action: "test.event", summary: "A test event." },
    });
    await expect(
      db.activityLog.update({ where: { id: entry.id }, data: { summary: "Rewritten" } }),
    ).rejects.toThrow();
    await expect(db.activityLog.delete({ where: { id: entry.id } })).rejects.toThrow();
    expect((await db.activityLog.findUnique({ where: { id: entry.id } }))?.summary).toBe("A test event.");
  });

  it("refuses an owner with a business, and staff without one", async () => {
    const db = getDb();
    await expect(
      db.user.update({ where: { id: world.owner.id }, data: { businessId: world.a.id } }),
    ).rejects.toThrow();
    await expect(
      db.user.update({ where: { id: world.a.staff.CASHIER.id }, data: { businessId: null } }),
    ).rejects.toThrow();
  });

  it("refuses a username containing capital letters", async () => {
    await expect(
      getDb().user.update({ where: { id: world.a.staff.CASHIER.id }, data: { username: "A.Cashier" } }),
    ).rejects.toThrow();
  });
});
