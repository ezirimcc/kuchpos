import { beforeEach, describe, expect, it } from "vitest";
import { changeOwnPassword } from "@/server/auth/account";
import { getAuth } from "@/server/auth/auth";
import { resolveContext } from "@/server/auth/context";
import { getBusinessSettings, setIdleSignOutMinutes } from "@/server/business/settings";
import { getDb } from "@/server/db/client";
import { NotSignedInError, ValidationError } from "@/server/errors";
import { contextFor, createWorld, TEST_PASSWORD, type World } from "../support/world";

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

async function signIn(username: string, password = TEST_PASSWORD): Promise<Headers> {
  const { headers } = await getAuth().api.signInUsername({ body: { username, password }, returnHeaders: true });
  return new Headers({
    cookie: headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; "),
  });
}

async function canSignIn(username: string, password: string): Promise<boolean> {
  try {
    await getAuth().api.signInUsername({ body: { username, password } });
    return true;
  } catch {
    return false;
  }
}

/** Pretends the person's screen has been unused for this many minutes. */
async function leaveIdle(userId: string, minutes: number) {
  await getDb().session.updateMany({
    where: { userId },
    data: { lastActiveAt: new Date(Date.now() - minutes * 60 * 1000) },
  });
}

describe("automatic sign-out", () => {
  it("starts at 30 minutes for a business", async () => {
    expect((await getBusinessSettings(world.a.as.ADMIN)).idleSignOutMinutes).toBe(30);
  });

  it("keeps a person signed in while they are within the time", async () => {
    const headers = await signIn("a.cashier");
    await leaveIdle(world.a.staff.CASHIER.id, 29);
    await expect(resolveContext(headers)).resolves.toBeTruthy();
  });

  it("signs a person out once the screen has been unused for longer than the setting", async () => {
    const headers = await signIn("a.cashier");
    await leaveIdle(world.a.staff.CASHIER.id, 31);

    const attempt = resolveContext(headers);
    await expect(attempt).rejects.toBeInstanceOf(NotSignedInError);
    await expect(attempt).rejects.toMatchObject({ reason: "idle" });
    // The session is gone, so the same cookie cannot be used again.
    await expect(resolveContext(headers)).rejects.toBeInstanceOf(NotSignedInError);
  });

  it("counts from the last use, not from sign-in", async () => {
    const headers = await signIn("a.cashier");
    await leaveIdle(world.a.staff.CASHIER.id, 20);
    await resolveContext(headers); // Using the app resets the clock…
    // (The test fixtures give this person a second session; look at the most recently used one.)
    const session = await getDb().session.findFirst({
      where: { userId: world.a.staff.CASHIER.id },
      orderBy: { lastActiveAt: "desc" },
    });
    expect(Date.now() - session!.lastActiveAt.getTime()).toBeLessThan(5_000);
  });

  it("follows the admin's setting", async () => {
    await setIdleSignOutMinutes(world.a.as.ADMIN, { minutes: "10" });
    const headers = await signIn("a.cashier");
    await leaveIdle(world.a.staff.CASHIER.id, 11);
    await expect(resolveContext(headers)).rejects.toMatchObject({ reason: "idle" });

    await setIdleSignOutMinutes(world.a.as.ADMIN, { minutes: "120" });
    const again = await signIn("a.cashier");
    await leaveIdle(world.a.staff.CASHIER.id, 110);
    await expect(resolveContext(again)).resolves.toBeTruthy();
  });

  it("is separate for each business", async () => {
    await setIdleSignOutMinutes(world.a.as.ADMIN, { minutes: "10" });
    expect((await getBusinessSettings(world.b.as.ADMIN)).idleSignOutMinutes).toBe(30);

    const headers = await signIn("b.cashier");
    await leaveIdle(world.b.staff.CASHIER.id, 20);
    await expect(resolveContext(headers)).resolves.toBeTruthy();
  });

  it("signs owners out after 30 minutes whatever a business's setting is", async () => {
    await setIdleSignOutMinutes(world.a.as.ADMIN, { minutes: "480" });
    const headers = await signIn("owner");
    await getDb().session.updateMany({ where: { userId: world.owner.id }, data: { activeBusinessId: world.a.id } });
    await leaveIdle(world.owner.id, 31);
    await expect(resolveContext(headers)).rejects.toMatchObject({ reason: "idle" });
  });

  it("refuses values outside 5 to 480 minutes, or that are not whole numbers", async () => {
    for (const minutes of ["4", "481", "0", "-5", "12.5", "abc", "", "1e2", "99999"]) {
      await expect(setIdleSignOutMinutes(world.a.as.ADMIN, { minutes }), minutes).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    expect((await getBusinessSettings(world.a.as.ADMIN)).idleSignOutMinutes).toBe(30);
  });

  it("is refused by the database itself if something bypasses the check", async () => {
    await expect(
      getDb().business.update({ where: { id: world.a.id }, data: { idleSignOutMinutes: 2 } }),
    ).rejects.toThrow();
  });

  it("records the change in the business's activity log", async () => {
    await setIdleSignOutMinutes(world.a.as.ADMIN, { minutes: "15" });
    const entry = await getDb().activityLog.findFirst({ where: { action: "settings.idle_sign_out_changed" } });
    expect(entry?.businessId).toBe(world.a.id);
    expect(entry?.summary).toMatch(/from 30 to 15 minutes/);
  });
});

describe("changing your own password", () => {
  const newPassword = "my-brand-new-password";

  it("works for every role, including owner", async () => {
    await changeOwnPassword(world.a.as.CASHIER, { currentPassword: TEST_PASSWORD, newPassword });
    expect(await canSignIn("a.cashier", newPassword)).toBe(true);
    expect(await canSignIn("a.cashier", TEST_PASSWORD)).toBe(false);

    await changeOwnPassword(world.ownerOutside, { currentPassword: TEST_PASSWORD, newPassword });
    expect(await canSignIn("owner", newPassword)).toBe(true);
  });

  it("refuses a wrong current password and changes nothing", async () => {
    await expect(
      changeOwnPassword(world.a.as.CASHIER, { currentPassword: "not-my-password", newPassword }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await canSignIn("a.cashier", TEST_PASSWORD)).toBe(true);
    expect(await canSignIn("a.cashier", newPassword)).toBe(false);
  });

  it("refuses a new password that is too short or the same as the current one", async () => {
    await expect(
      changeOwnPassword(world.a.as.CASHIER, { currentPassword: TEST_PASSWORD, newPassword: "short" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      changeOwnPassword(world.a.as.CASHIER, { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("only ever changes the signed-in person's own account, whatever else is sent", async () => {
    await changeOwnPassword(world.a.as.CASHIER, {
      currentPassword: TEST_PASSWORD,
      newPassword,
      userId: world.a.staff.ADMIN.id,
      username: "a.admin",
    });
    expect(await canSignIn("a.admin", TEST_PASSWORD)).toBe(true);
    expect(await canSignIn("a.admin", newPassword)).toBe(false);
    expect(await canSignIn("a.cashier", newPassword)).toBe(true);
  });

  it("signs the person out on other computers but not this one", async () => {
    const cashier = world.a.staff.CASHIER;
    const otherComputer = await contextFor(cashier, { id: world.a.id, name: world.a.name });

    await changeOwnPassword(world.a.as.CASHIER, { currentPassword: TEST_PASSWORD, newPassword });

    const remaining = await getDb().session.findMany({ where: { userId: cashier.id } });
    expect(remaining.map((session) => session.id)).toEqual([world.a.as.CASHIER.actor.sessionId]);
    expect(remaining.map((session) => session.id)).not.toContain(otherComputer.actor.sessionId);
  });

  it("is logged without the password, in the person's own business", async () => {
    await changeOwnPassword(world.a.as.CASHIER, { currentPassword: TEST_PASSWORD, newPassword });
    const entry = await getDb().activityLog.findFirst({ where: { action: "account.password_changed" } });
    expect(entry?.businessId).toBe(world.a.id);
    expect(JSON.stringify(entry)).not.toContain(newPassword);
    expect(JSON.stringify(entry)).not.toContain(TEST_PASSWORD);
  });
});

describe("profile and dashboard", () => {
  it("shows a person their own basic details", async () => {
    const { getOwnProfile } = await import("@/server/auth/account");
    const profile = await getOwnProfile(world.a.as.CASHIER);
    expect(profile).toMatchObject({
      username: "a.cashier",
      role: "CASHIER",
      businessName: "Business A",
      idleSignOutMinutes: 30,
    });
    expect(profile.signedInAt).toBeInstanceOf(Date);

    const owner = await getOwnProfile(world.ownerOutside);
    expect(owner).toMatchObject({ username: "owner", role: "OWNER", businessName: null, idleSignOutMinutes: 30 });
  });

  it("gives each role only the dashboard figures it may see", async () => {
    const { getDashboard } = await import("@/server/business/dashboard");
    const admin = await getDashboard(world.a.as.ADMIN);
    expect(admin).toMatchObject({ products: 1, categories: 2, taxRatePercent: "0.00", staff: 5 });
    expect(admin.activityToday).toBeGreaterThanOrEqual(0);
    expect(admin.recentActivity).not.toBeNull();

    const manager = await getDashboard(world.a.as.MANAGER);
    expect(manager.staff).toBeNull();
    expect(manager.recentActivity).not.toBeNull();

    for (const role of ["CASHIER", "STOREKEEPER"] as const) {
      const snapshot = await getDashboard(world.a.as[role]);
      expect(snapshot).toMatchObject({ products: 1, categories: 2, staff: null, activityToday: null, recentActivity: null });
    }
  });

  it("counts only the business in use on the dashboard", async () => {
    const { getDashboard } = await import("@/server/business/dashboard");
    await getDb().product.createMany({
      data: Array.from({ length: 4 }, (_, index) => ({ businessId: world.b.id, name: `B extra ${index}`, allowsFraction: false })),
    });
    expect((await getDashboard(world.a.as.ADMIN)).products).toBe(1);
    expect((await getDashboard(world.b.as.ADMIN)).products).toBe(5);
  });
});
