/**
 * Fills the database with INVENTED sample data: one owner and two businesses,
 * each with one person per role. It first EMPTIES every table.
 *
 * Run with:  npm run db:seed
 *
 * It refuses to run against anything but a local development or test database
 * unless SEED_CONFIRM is set to that database's exact name (used for the online
 * test site only — never the live system).
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import "dotenv/config";
import { PrismaClient, type Role } from "../src/generated/prisma/client";

const ROLES: { role: Exclude<Role, "OWNER">; label: string }[] = [
  { role: "ADMIN", label: "Admin" },
  { role: "MANAGER", label: "Manager" },
  { role: "ACCOUNTANT", label: "Accountant" },
  { role: "CASHIER", label: "Cashier" },
  { role: "STOREKEEPER", label: "Storekeeper" },
];

const BUSINESSES = [
  { name: "Green Valley Agro (sample)", prefix: "gv", short: "Green Valley" },
  { name: "Sunrise Farm Supplies (sample)", prefix: "sf", short: "Sunrise" },
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const password = process.env.SEED_PASSWORD;
  if (!connectionString) throw new Error("DATABASE_URL is not set. See .env.example.");
  if (!password || password.length < 8) {
    throw new Error("SEED_PASSWORD is not set (or is shorter than 8 characters). See .env.example.");
  }

  const databaseName = new URL(connectionString).pathname.replace(/^\//, "");
  const isLocalSample = /_(dev|test)$/.test(databaseName);
  if (!isLocalSample && process.env.SEED_CONFIRM !== databaseName) {
    throw new Error(
      `Refusing to wipe and seed "${databaseName}". This command is for sample-data databases only. ` +
        `To seed the online TEST site, set SEED_CONFIRM to the database name. Never do this on the live system.`,
    );
  }

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const passwordHash = await hashPassword(password);

  const person = (name: string, username: string, role: Role, businessId: string | null) => {
    const id = randomUUID();
    return db.user.create({
      data: {
        id,
        name,
        username,
        displayUsername: username,
        email: `${username}@users.kuchpos.invalid`,
        role,
        businessId,
        accounts: {
          create: { id: randomUUID(), accountId: id, providerId: "credential", password: passwordHash },
        },
      },
    });
  };

  await db.$executeRawUnsafe(
    'TRUNCATE "activity_log", "session", "account", "verification", "user", "business" CASCADE',
  );

  await person("Sample Owner", "owner", "OWNER", null);
  const usernames = ["owner"];

  for (const business of BUSINESSES) {
    const created = await db.business.create({
      data: { name: business.name, nameKey: business.name.toLowerCase() },
    });
    for (const { role, label } of ROLES) {
      const username = `${business.prefix}.${label.toLowerCase()}`;
      await person(`${business.short} ${label}`, username, role, created.id);
      usernames.push(username);
    }
  }

  await db.$disconnect();
  console.log(`Sample data loaded into "${databaseName}".`);
  console.log(`Sample usernames: ${usernames.join(", ")}`);
  console.log("They all share the password set as SEED_PASSWORD in your .env file.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
