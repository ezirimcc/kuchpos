import "server-only";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
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
  return new PrismaClient({ adapter: new PrismaMariaDb(poolConfigFromUrl(connectionString)) });
}

/**
 * Turns a `mysql://user:password@host:port/database` address into connection settings.
 * Every connection is switched to universal time (UTC) so stored times never depend on
 * where the database server happens to be.
 */
export function poolConfigFromUrl(connectionString: string) {
  const url = new URL(connectionString);
  if (url.protocol !== "mysql:" && url.protocol !== "mariadb:") {
    throw new Error("DATABASE_URL must start with mysql:// (KuchPos uses MariaDB).");
  }
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    // Shared hosting allows only a limited number of connections; a handful is plenty.
    connectionLimit: 5,
    initSql: "SET time_zone = '+00:00'",
  };
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
