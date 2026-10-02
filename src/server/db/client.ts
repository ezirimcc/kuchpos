import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * The raw, UNSCOPED database client.
 *
 * Only the login code (src/server/auth), the cross-business owner code
 * (src/server/platform) and this folder may import it. Everything else must
 * use `businessDb()` from ./scoped, which limits every query to one business.
 * An ESLint rule enforces this.
 */
function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// In development the server reloads code often; reuse one client so connections do not pile up.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function getDb(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }
  return globalForPrisma.prisma;
}

/** Asks the database a trivial question to confirm it is reachable. */
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    await getDb().$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error("Database check failed:", error);
    return false;
  }
}
