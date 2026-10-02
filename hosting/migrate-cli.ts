import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { applyMigrations } from "./migrate";

/** Run on the hosting server with:  npm run migrate  (from the application folder). */
async function main() {
  const envFile = resolve(process.cwd(), ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set. Check the .env file in the application folder.");

  const result = await applyMigrations({
    databaseUrl,
    migrationsDir: resolve(process.cwd(), "migrations"),
    log: (message) => console.log(message),
  });

  if (result.applied.length === 0) {
    console.log(`The database is already up to date (${result.alreadyApplied.length} updates applied earlier).`);
  } else {
    console.log(`Done. Applied ${result.applied.length} database update(s): ${result.applied.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
