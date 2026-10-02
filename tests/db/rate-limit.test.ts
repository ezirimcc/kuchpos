import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAuth } from "@/server/auth/auth";
import { DEFAULT_SIGN_IN_ATTEMPTS_PER_MINUTE } from "@/server/auth/config";
import { createWorld, TEST_PASSWORD } from "../support/world";

beforeAll(() => {
  // Rate limiting is off in development; switch it on for this file (read when the login system is first created).
  process.env.RATE_LIMIT = "on";
});

beforeEach(async () => {
  await createWorld();
});

/** A sign-in request as it arrives over the web, from the given internet address. */
function signInRequest(address: string, password: string): Promise<Response> {
  return getAuth().handler(
    new Request("http://localhost:3000/api/auth/sign-in/username", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "x-forwarded-for": address,
      },
      body: JSON.stringify({ username: "a.cashier", password }),
    }),
  );
}

describe("sign-in attempt limiting", () => {
  it("allows ten wrong guesses a minute from one address, then tells it to wait", async () => {
    for (let attempt = 1; attempt <= DEFAULT_SIGN_IN_ATTEMPTS_PER_MINUTE; attempt++) {
      expect((await signInRequest("203.0.113.10", "wrong-guess")).status, `attempt ${attempt}`).toBe(401);
    }
    const blocked = await signInRequest("203.0.113.10", "wrong-guess");
    expect(blocked.status).toBe(429);
  });

  it("refuses even the right password while the address is blocked", async () => {
    for (let attempt = 1; attempt <= DEFAULT_SIGN_IN_ATTEMPTS_PER_MINUTE; attempt++) {
      await signInRequest("203.0.113.11", "wrong-guess");
    }
    expect((await signInRequest("203.0.113.11", TEST_PASSWORD)).status).toBe(429);
  });

  it("does not block a different address", async () => {
    for (let attempt = 1; attempt <= DEFAULT_SIGN_IN_ATTEMPTS_PER_MINUTE + 1; attempt++) {
      await signInRequest("203.0.113.12", "wrong-guess");
    }
    expect((await signInRequest("198.51.100.7", TEST_PASSWORD)).status).toBe(200);
  });
});
