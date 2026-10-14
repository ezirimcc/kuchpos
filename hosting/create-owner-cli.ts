import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { createConnection } from "mariadb";
import { MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH, USERNAME_PATTERN } from "../src/server/auth/config";
import { connectionSettings } from "./backup-core";
import { loadToolEnv, required } from "./tool-env";

/**
 * Creates the FIRST owner on an empty live database (C79), with "Run JS script" → create-owner.
 * Takes the name and username from FIRST_OWNER_NAME and FIRST_OWNER_USERNAME in .env, and
 * prints a one-time password that the owner changes straight after signing in (Profile →
 * Change password). Refuses if the database already has any account. Further owners and all
 * staff are then created inside KuchPos.
 */
async function main() {
  loadToolEnv();
  const databaseUrl = required("DATABASE_URL", "");
  const name = required("FIRST_OWNER_NAME", "Put your full name there.").trim();
  const username = required("FIRST_OWNER_USERNAME", "Put the username you will sign in with there.").trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username) || username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH) {
    throw new Error(`FIRST_OWNER_USERNAME may use only letters, digits, dots and underscores (${MIN_USERNAME_LENGTH} to ${MAX_USERNAME_LENGTH}).`);
  }

  const db = await createConnection(connectionSettings(databaseUrl));
  try {
    const [{ n }] = await db.query<{ n: bigint | number }[]>("SELECT COUNT(*) AS n FROM `user`");
    if (Number(n) > 0) throw new Error("This database already has accounts. The first owner can only be created on an empty database.");
    const password = randomBytes(12).toString("base64url");
    const id = randomUUID();
    await db.beginTransaction();
    await db.query(
      "INSERT INTO `user` (id, name, username, displayUsername, email, emailVerified, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, FALSE, 'OWNER', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      [id, name, username, username, `${username}@users.kuchpos.invalid`],
    );
    await db.query(
      "INSERT INTO `account` (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
      [randomUUID(), id, id, await hashPassword(password)],
    );
    await db.commit();
    console.log(`Owner "${name}" created. Sign in with the username ${username} and this one-time password:`);
    console.log("");
    console.log(`    ${password}`);
    console.log("");
    console.log("Change it straight away: Profile → Change password. Then remove the FIRST_OWNER lines from .env.");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
