import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "mariadb";

/**
 * Applies the Prisma migration files in order, on a server where the Prisma
 * command-line tool is not installed (the shared hosting server).
 *
 * It keeps its records in the same `_prisma_migrations` table, in the same
 * format, as `prisma migrate deploy`, so the two can be used interchangeably
 * on a database. A test checks that Prisma agrees with what this tool did.
 */

export type MigrateResult = { applied: string[]; alreadyApplied: string[] };

const LOCK_NAME = "kuchpos_migrate";

const CREATE_RECORDS_TABLE = `
CREATE TABLE IF NOT EXISTS \`_prisma_migrations\` (
  \`id\` VARCHAR(36) NOT NULL,
  \`checksum\` VARCHAR(64) NOT NULL,
  \`finished_at\` DATETIME(3) NULL,
  \`migration_name\` VARCHAR(255) NOT NULL,
  \`logs\` TEXT NULL,
  \`rolled_back_at\` DATETIME(3) NULL,
  \`started_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`applied_steps_count\` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (\`id\`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;

type RecordRow = {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
};

function connectionSettings(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (url.protocol !== "mysql:" && url.protocol !== "mariadb:") {
    throw new Error("DATABASE_URL must start with mysql:// (KuchPos uses MariaDB).");
  }
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    // A migration file holds several statements.
    multipleStatements: true,
    initSql: "SET time_zone = '+00:00'",
  };
}

export async function applyMigrations(options: {
  databaseUrl: string;
  migrationsDir: string;
  log?: (message: string) => void;
}): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  if (!existsSync(options.migrationsDir)) {
    throw new Error(`Migrations folder not found: ${options.migrationsDir}`);
  }
  const names = readdirSync(options.migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(options.migrationsDir, entry.name, "migration.sql")))
    .map((entry) => entry.name)
    .sort();

  const connection = await createConnection(connectionSettings(options.databaseUrl));
  const result: MigrateResult = { applied: [], alreadyApplied: [] };

  try {
    // Only one copy of this tool may change the database structure at a time.
    const [lock] = await connection.query<{ acquired: number | bigint | null }[]>(
      "SELECT GET_LOCK(?, 30) AS acquired",
      [LOCK_NAME],
    );
    if (Number(lock?.acquired) !== 1) {
      throw new Error("Another database update is already running. Try again in a minute.");
    }

    await connection.query(CREATE_RECORDS_TABLE);
    const records = await connection.query<RecordRow[]>(
      "SELECT `migration_name`, `checksum`, `finished_at`, `rolled_back_at` FROM `_prisma_migrations`",
    );

    const unfinished = records.find((row) => !row.finished_at && !row.rolled_back_at);
    if (unfinished) {
      throw new Error(
        `An earlier database update ("${unfinished.migration_name}") did not finish. ` +
          "Nothing was changed this time. This needs to be looked at before continuing.",
      );
    }

    for (const name of names) {
      const sql = readFileSync(join(options.migrationsDir, name, "migration.sql"), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const done = records.find((row) => row.migration_name === name && row.finished_at);

      if (done) {
        if (done.checksum !== checksum) {
          throw new Error(
            `The database update "${name}" was changed after it had been applied. ` +
              "Applied updates must never be edited. Nothing was changed this time.",
          );
        }
        result.alreadyApplied.push(name);
        continue;
      }

      log(`Applying ${name} …`);
      const id = randomUUID();
      await connection.query(
        "INSERT INTO `_prisma_migrations` (`id`, `checksum`, `migration_name`, `started_at`) VALUES (?, ?, ?, UTC_TIMESTAMP(3))",
        [id, checksum, name],
      );
      try {
        await connection.query(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await connection.query("UPDATE `_prisma_migrations` SET `logs` = ? WHERE `id` = ?", [message, id]);
        throw new Error(`The database update "${name}" failed and was stopped: ${message}`);
      }
      await connection.query(
        "UPDATE `_prisma_migrations` SET `finished_at` = UTC_TIMESTAMP(3), `applied_steps_count` = 1 WHERE `id` = ?",
        [id],
      );
      result.applied.push(name);
    }

    await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
    return result;
  } finally {
    await connection.end();
  }
}
