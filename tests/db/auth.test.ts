import { beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_AUTH_PATHS, getAuth } from "@/server/auth/auth";
import { resolveContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { NotSignedInError } from "@/server/errors";
import { setStaffDisabled } from "@/server/business/staff";
import { setBusinessActive } from "@/server/platform/businesses";
import { createWorld, TEST_PASSWORD, type World } from "../support/world";

let world: World;
beforeEach(async () => {
  world = await createWorld();
});

/** Signs in through the login library and returns the request headers a browser would then send. */
async function signIn(username: string, password = TEST_PASSWORD): Promise<Headers> {
  const { headers } = await getAuth().api.signInUsername({
    body: { username, password },
    returnHeaders: true,
  });
  const cookies = headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  return new Headers({ cookie: cookies });
}

describe("signing in", () => {
  it("accepts the right username and password", async () => {
    const context = await resolveContext(await signIn("a.cashier"));
    expect(context.actor.username).toBe("a.cashier");
    expect(context.actor.role).toBe("CASHIER");
    expect(context.business).toEqual({ id: world.a.id, name: "Business A" });
  });

  it("treats the username as case-insensitive", async () => {
    const context = await resolveContext(await signIn("A.Cashier"));
    expect(context.actor.username).toBe("a.cashier");
  });

  it("refuses a wrong password", async () => {
    await expect(signIn("a.cashier", "wrong-password")).rejects.toThrow();
  });

  it("refuses an unknown username", async () => {
    await expect(signIn("nobody")).rejects.toThrow();
  });

  it("refuses a disabled account even with the right password", async () => {
    await setStaffDisabled(world.a.as.ADMIN, { userId: world.a.staff.CASHIER.id, disabled: true });
    await expect(signIn("a.cashier")).rejects.toThrow(/disabled/);
  });

  it("refuses staff of a deactivated business", async () => {
    await setBusinessActive(world.ownerOutside, { businessId: world.a.id, active: false });
    await expect(signIn("a.cashier")).rejects.toThrow(/deactivated/);
  });

  it("records the sign-in in that business's activity log", async () => {
    await signIn("a.cashier");
    const entry = await getDb().activityLog.findFirst({ where: { action: "auth.signed_in" } });
    expect(entry?.businessId).toBe(world.a.id);
    expect(entry?.actorUserId).toBe(world.a.staff.CASHIER.id);
  });

  it("gives an owner no business until they open one", async () => {
    const context = await resolveContext(await signIn("owner"));
    expect(context.actor.role).toBe("OWNER");
    expect(context.business).toBeNull();
  });
});

describe("no public sign-up", () => {
  it("refuses to create an account through the login library", async () => {
    await expect(
      getAuth().api.signUpEmail({
        body: { name: "Intruder", email: "intruder@example.com", password: "password-1234" },
      }),
    ).rejects.toThrow();
    expect(await getDb().user.count({ where: { email: "intruder@example.com" } })).toBe(0);
  });

  it("exposes only sign-in, sign-out and session lookup over the web", () => {
    expect(ALLOWED_AUTH_PATHS).toEqual([
      { method: "POST", path: "/api/auth/sign-in/username" },
      { method: "POST", path: "/api/auth/sign-out" },
      { method: "GET", path: "/api/auth/get-session" },
    ]);
  });
});

describe("every request is re-checked", () => {
  it("refuses a request with no session", async () => {
    await expect(resolveContext(new Headers())).rejects.toBeInstanceOf(NotSignedInError);
  });

  it("refuses a made-up session cookie", async () => {
    const forged = new Headers({ cookie: "better-auth.session_token=not-a-real-token.signature" });
    await expect(resolveContext(forged)).rejects.toBeInstanceOf(NotSignedInError);
  });

  it("signs a person out the moment their account is disabled", async () => {
    const headers = await signIn("a.cashier");
    await resolveContext(headers); // Works while enabled.

    await setStaffDisabled(world.a.as.ADMIN, { userId: world.a.staff.CASHIER.id, disabled: true });

    await expect(resolveContext(headers)).rejects.toBeInstanceOf(NotSignedInError);
    expect(await getDb().session.count({ where: { userId: world.a.staff.CASHIER.id } })).toBe(0);
  });

  it("locks out a disabled account even if a session row survived", async () => {
    const headers = await signIn("a.cashier");
    // Disable directly, leaving the session in place, to prove the per-request check stands on its own.
    await getDb().user.update({ where: { id: world.a.staff.CASHIER.id }, data: { disabledAt: new Date() } });
    await expect(resolveContext(headers)).rejects.toBeInstanceOf(NotSignedInError);
  });

  it("signs staff out the moment their business is deactivated", async () => {
    const headers = await signIn("a.manager");
    await setBusinessActive(world.ownerOutside, { businessId: world.a.id, active: false });
    await expect(resolveContext(headers)).rejects.toBeInstanceOf(NotSignedInError);
  });

  it("does not affect the other business when one is deactivated", async () => {
    const headers = await signIn("b.manager");
    await setBusinessActive(world.ownerOutside, { businessId: world.a.id, active: false });
    const context = await resolveContext(headers);
    expect(context.business?.id).toBe(world.b.id);
  });

  it("takes a staff member's business from the server, never from the request", async () => {
    const headers = await signIn("a.admin");
    headers.set("x-business-id", world.b.id);
    headers.append("cookie", `activeBusinessId=${world.b.id}`);
    const context = await resolveContext(headers);
    expect(context.business?.id).toBe(world.a.id);
  });
});
