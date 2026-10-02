import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

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

export type DatabaseStatus =
  | { connected: true; serverVersion: string }
  | { connected: false; reason: string };

/** Asks the database a trivial question to confirm it is reachable. */
export async function checkDatabase(): Promise<DatabaseStatus> {
  try {
    const rows = await getDb().$queryRaw<{ server_version: string }[]>`SHOW server_version`;
    return { connected: true, serverVersion: rows[0]?.server_version ?? "unknown" };
  } catch (error) {
    console.error("Database check failed:", error);
    return { connected: false, reason: "The app could not reach the database." };
  }
}
