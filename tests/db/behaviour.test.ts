import { beforeEach, describe, expect, it } from "vitest";
import { getAuth } from "@/server/auth/auth";
import { resolveContext } from "@/server/auth/context";
import { listActivity } from "@/server/business/activity-log";
import {
  createStaff,
  listStaff,
  resetStaffPassword,
  setStaffDisabled,
  setStaffRole,
} from "@/server/business/staff";
import { getDb } from "@/server/db/client";
import { ValidationError } from "@/server/errors";
import {
  closeBusiness,
  createBusiness,
  listBusinesses,
  openBusiness,
  renameBusiness,
  setBusinessActive,
} from "@/server/platform/businesses";
import { createOwner, listPlatformActivity, setOwnerDisabled } from "@/server/platform/owners";
import { contextFor, createUser, createWorld, TEST_PASSWORD, type World } from "../support/world";

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

async function canSignIn(username: string, password: string): Promise<boolean> {
  try {
    await getAuth().api.signInUsername({ body: { username, password } });
    return true;
  } catch {
    return false;
  }
}

async function fieldErrorsOf(attempt: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ValidationError) return error.fieldErrors;
    throw error;
  }
  throw new Error("Expected the call to be refused.");
}

describe("creating a business", () => {
  const input = {
    name: "Green Valley Agro",
    adminName: "Ada Admin",
    adminUsername: "greenvalley.admin",
    adminPassword: "a-good-password",
  };

  it("creates the business and its first admin, who can then sign in", async () => {
    const { id } = await createBusiness(world.ownerOutside, input);
    const admin = await getDb().user.findUnique({ where: { username: "greenvalley.admin" } });
    expect(admin?.businessId).toBe(id);
    expect(admin?.role).toBe("ADMIN");
    expect(await canSignIn("greenvalley.admin", "a-good-password")).toBe(true);
  });

  it("stores the password scrambled, never as typed", async () => {
    await createBusiness(world.ownerOutside, input);
    const account = await getDb().account.findFirst({ where: { user: { username: "greenvalley.admin" } } });
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toContain("a-good-password");
  });

  it("saves nothing if the admin's username is already taken", async () => {
    const before = await getDb().business.count();
    const errors = await fieldErrorsOf(
      createBusiness(world.ownerOutside, { ...input, adminUsername: "a.cashier" }),
    );
    expect(errors.adminUsername).toMatch(/already taken/);
    expect(await getDb().business.count()).toBe(before);
  });

  it("refuses a second business with the same name, ignoring capitals and spacing", async () => {
    await createBusiness(world.ownerOutside, input);
    const errors = await fieldErrorsOf(
      createBusiness(world.ownerOutside, {
        ...input,
        name: "  green   VALLEY agro ",
        adminUsername: "other.admin",
      }),
    );
    expect(errors.name).toMatch(/already exists/);
  });

  it("creates only one business when the same request is sent twice at once", async () => {
    const results = await Promise.allSettled([
      createBusiness(world.ownerOutside, input),
      createBusiness(world.ownerOutside, input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await getDb().business.count({ where: { nameKey: "green valley agro" } })).toBe(1);
    expect(await getDb().user.count({ where: { username: "greenvalley.admin" } })).toBe(1);
  });

  it("refuses weak or malformed input with a message per field", async () => {
    const errors = await fieldErrorsOf(
      createBusiness(world.ownerOutside, {
        name: "X",
        adminName: "",
        adminUsername: "has spaces!",
        adminPassword: "short",
      }),
    );
    expect(Object.keys(errors).sort()).toEqual(["adminName", "adminPassword", "adminUsername", "name"]);
  });

  it("is recorded in the system log and the new business's own log", async () => {
    const { id } = await createBusiness(world.ownerOutside, input);
    const platform = await listPlatformActivity(world.ownerOutside);
    expect(platform.some((entry) => entry.action === "business.created")).toBe(true);
    const inBusiness = await getDb().activityLog.findMany({ where: { businessId: id } });
    expect(inBusiness.map((entry) => entry.action)).toEqual(["staff.created"]);
  });
});

describe("renaming and deactivating a business", () => {
  it("renames a business", async () => {
    await renameBusiness(world.ownerOutside, { businessId: world.a.id, name: "Business Alpha" });
    const list = await listBusinesses(world.ownerOutside);
    expect(list.map((business) => business.name)).toContain("Business Alpha");
  });

  it("refuses to rename to a name another business has", async () => {
    const errors = await fieldErrorsOf(
      renameBusiness(world.ownerOutside, { businessId: world.a.id, name: "business b" }),
    );
    expect(errors.name).toMatch(/already exists/);
  });

  it("deactivating signs out its staff, keeps its records, and can be undone", async () => {
    await setBusinessActive(world.ownerOutside, { businessId: world.a.id, active: false });

    expect(await getDb().session.count({ where: { user: { businessId: world.a.id } } })).toBe(0);
    expect(await getDb().user.count({ where: { businessId: world.a.id } })).toBe(5);
    expect(await canSignIn("a.admin", TEST_PASSWORD)).toBe(false);
    expect(await canSignIn("b.admin", TEST_PASSWORD)).toBe(true);

    await setBusinessActive(world.ownerOutside, { businessId: world.a.id, active: true });
    expect(await canSignIn("a.admin", TEST_PASSWORD)).toBe(true);
  });

  it("closes a deactivated business for any owner who had it open", async () => {
    await setBusinessActive(world.ownerOutside, { businessId: world.a.id, active: false });
    const session = await getDb().session.findUnique({ where: { id: world.ownerInA.actor.sessionId } });
    expect(session?.activeBusinessId).toBeNull();
  });
});

describe("an owner opening a business", () => {
  async function ownerHeaders(): Promise<Headers> {
    const { headers } = await getAuth().api.signInUsername({
      body: { username: "owner", password: TEST_PASSWORD },
      returnHeaders: true,
    });
    return new Headers({
      cookie: headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; "),
    });
  }

  it("remembers the open business on the server and can switch and close", async () => {
    const headers = await ownerHeaders();
    let context = await resolveContext(headers);
    expect(context.business).toBeNull();

    await openBusiness(context, { businessId: world.a.id });
    context = await resolveContext(headers);
    expect(context.business?.name).toBe("Business A");

    await openBusiness(context, { businessId: world.b.id });
    context = await resolveContext(headers);
    expect(context.business?.name).toBe("Business B");

    await closeBusiness(context);
    context = await resolveContext(headers);
    expect(context.business).toBeNull();
  });

  it("acts as that business's admin, and only inside it", async () => {
    const headers = await ownerHeaders();
    await openBusiness(await resolveContext(headers), { businessId: world.a.id });
    const context = await resolveContext(headers);

    const list = await listStaff(context);
    expect(list.every((person) => person.username.startsWith("a."))).toBe(true);
  });

  it("writes the owner's actions into that business's log under the owner's name", async () => {
    const headers = await ownerHeaders();
    await openBusiness(await resolveContext(headers), { businessId: world.a.id });
    const context = await resolveContext(headers);
    await createStaff(context, {
      name: "Hired By Owner",
      username: "hired.by.owner",
      password: "a-good-password",
      role: "CASHIER",
    });

    const log = (await listActivity(world.a.as.ADMIN)).entries;
    const opened = log.find((entry) => entry.action === "owner.opened_business");
    const created = log.find((entry) => entry.action === "staff.created");
    expect(opened?.actorName).toBe(world.owner.name);
    expect(created?.actorName).toBe(world.owner.name);
    expect(created?.actorRole).toBe("OWNER");
  });

  it("cannot open a deactivated or non-existent business", async () => {
    await setBusinessActive(world.ownerOutside, { businessId: world.b.id, active: false });
    await expect(openBusiness(world.ownerOutside, { businessId: world.b.id })).rejects.toThrow(/deactivated/);
    await expect(
      openBusiness(world.ownerOutside, { businessId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow(/could not be found/);
  });
});

describe("owners", () => {
  it("creates another owner who can sign in and belongs to no business", async () => {
    await createOwner(world.ownerOutside, {
      name: "Second Owner",
      username: "second.owner",
      password: "a-good-password",
    });
    const owner = await getDb().user.findUnique({ where: { username: "second.owner" } });
    expect(owner?.role).toBe("OWNER");
    expect(owner?.businessId).toBeNull();
    expect(await canSignIn("second.owner", "a-good-password")).toBe(true);
  });

  it("refuses to disable the last active owner", async () => {
    await expect(
      setOwnerDisabled(world.ownerOutside, { userId: world.owner.id, disabled: true }),
    ).rejects.toThrow(/last active owner/);
    expect((await getDb().user.findUnique({ where: { id: world.owner.id } }))?.disabledAt).toBeNull();
  });

  it("disables an owner when another remains, and signs them out", async () => {
    const second = await createUser({ username: "second.owner", role: "OWNER", businessId: null });
    await contextFor(second, null);

    await setOwnerDisabled(world.ownerOutside, { userId: second.id, disabled: true });

    expect(await canSignIn("second.owner", TEST_PASSWORD)).toBe(false);
    expect(await getDb().session.count({ where: { userId: second.id } })).toBe(0);
  });

  it("never ends with zero owners when two owners disable each other at the same moment", async () => {
    const second = await createUser({ username: "second.owner", role: "OWNER", businessId: null });
    const secondContext = await contextFor(second, null);

    const results = await Promise.allSettled([
      setOwnerDisabled(world.ownerOutside, { userId: second.id, disabled: true }),
      setOwnerDisabled(secondContext, { userId: world.owner.id, disabled: true }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await getDb().user.count({ where: { role: "OWNER", disabledAt: null } })).toBe(1);
  });
});

describe("staff accounts", () => {
  const input = { name: "Chidi Cashier", username: "Chidi.Cashier", password: "a-good-password", role: "CASHIER" };

  it("creates a staff member in the admin's own business, with a lower-case username", async () => {
    const { id } = await createStaff(world.a.as.ADMIN, input);
    const created = await getDb().user.findUnique({ where: { id } });
    expect(created?.businessId).toBe(world.a.id);
    expect(created?.username).toBe("chidi.cashier");
    expect(await canSignIn("chidi.cashier", "a-good-password")).toBe(true);
  });

  it("ignores any business the caller tries to pass in", async () => {
    const { id } = await createStaff(world.a.as.ADMIN, { ...input, businessId: world.b.id });
    expect((await getDb().user.findUnique({ where: { id } }))?.businessId).toBe(world.a.id);
  });

  it("refuses a username that exists anywhere in the system", async () => {
    const errors = await fieldErrorsOf(createStaff(world.a.as.ADMIN, { ...input, username: "b.cashier" }));
    expect(errors.username).toMatch(/already taken/);
  });

  it("creates only one account when the same request is sent twice at once", async () => {
    const results = await Promise.allSettled([
      createStaff(world.a.as.ADMIN, input),
      createStaff(world.a.as.ADMIN, input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await getDb().user.count({ where: { username: "chidi.cashier" } })).toBe(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ValidationError);
  });

  it("changes a role and records the old and new role", async () => {
    await setStaffRole(world.a.as.ADMIN, { userId: world.a.staff.CASHIER.id, role: "STOREKEEPER" });
    expect((await getDb().user.findUnique({ where: { id: world.a.staff.CASHIER.id } }))?.role).toBe("STOREKEEPER");
    const log = (await listActivity(world.a.as.ADMIN)).entries;
    expect(log[0].summary).toMatch(/from Cashier to Storekeeper/);
  });

  it("refuses changing your own role or disabling your own account", async () => {
    await expect(
      setStaffRole(world.a.as.ADMIN, { userId: world.a.staff.ADMIN.id, role: "CASHIER" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      setStaffDisabled(world.a.as.ADMIN, { userId: world.a.staff.ADMIN.id, disabled: true }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("disabling blocks sign-in and re-enabling restores it; the account is never deleted", async () => {
    const cashier = world.a.staff.CASHIER;
    await setStaffDisabled(world.a.as.ADMIN, { userId: cashier.id, disabled: true });
    expect(await canSignIn("a.cashier", TEST_PASSWORD)).toBe(false);
    expect(await getDb().user.count({ where: { id: cashier.id } })).toBe(1);

    await setStaffDisabled(world.a.as.ADMIN, { userId: cashier.id, disabled: false });
    expect(await canSignIn("a.cashier", TEST_PASSWORD)).toBe(true);
  });

  it("resetting a password replaces the old one and signs the person out", async () => {
    const cashier = world.a.staff.CASHIER;
    await resetStaffPassword(world.a.as.ADMIN, { userId: cashier.id, password: "brand-new-password" });

    expect(await canSignIn("a.cashier", TEST_PASSWORD)).toBe(false);
    expect(await canSignIn("a.cashier", "brand-new-password")).toBe(true);
    expect(await getDb().session.count({ where: { userId: cashier.id, createdAt: { lt: new Date(Date.now() - 500) } } })).toBe(0);
  });

  it("never writes a password into the activity log", async () => {
    await createStaff(world.a.as.ADMIN, input);
    await resetStaffPassword(world.a.as.ADMIN, { userId: world.a.staff.CASHIER.id, password: "brand-new-password" });
    const rows = await getDb().activityLog.findMany();
    const text = JSON.stringify(rows);
    expect(text).not.toContain("a-good-password");
    expect(text).not.toContain("brand-new-password");
  });
});

describe("system check", () => {
  it("confirms the database enforces its own rules, and leaves nothing behind", async () => {
    const { getSystemCheck } = await import("@/server/platform/system");
    const businessesBefore = await getDb().business.count();
    const logBefore = await getDb().activityLog.count();

    const check = await getSystemCheck(world.ownerOutside, {
      forwardedFor: "203.0.113.20, 10.0.0.1",
      forwardedProto: "https",
    });

    expect(check.rules).toHaveLength(6);
    expect(check.rules.filter((rule) => !rule.enforced)).toEqual([]);
    expect(check.databaseTimeZone).toBe("+00:00");
    expect(check.visitorAddress).toBe("203.0.113.20");
    expect(await getDb().business.count()).toBe(businessesBefore);
    expect(await getDb().activityLog.count()).toBe(logBefore);
    expect((await getDb().user.findUnique({ where: { id: world.owner.id } }))?.businessId).toBeNull();
  });
});
