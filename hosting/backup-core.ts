import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readdirSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { type Connection, createConnection } from "mariadb";
import { applyMigrations } from "./migrate";

/**
 * KuchPos's own backups (C79): the whole database in one encrypted file, and loading such a
 * file back into a spare database.
 *
 * A backup is every table read at ONE moment (a consistent snapshot), written as lines of
 * JSON, compressed, and encrypted with AES-256-GCM under a key made from the backup
 * passphrase (`BACKUP_PASSPHRASE`). Without the passphrase the file cannot be read; a file
 * that was changed or cut short is refused. Sign-in sessions and sign-in counters are left
 * out: after a restore everyone simply signs in again.
 *
 * A restore never touches the live database: the target's name must contain "restore", and
 * must differ from the database the app uses. The file is checked from end to end BEFORE
 * the target is emptied. The database structure is rebuilt with the migration files the
 * backup was made with, the rows are loaded, any later migrations are applied, and then the
 * row counts and KuchPos's own rules (stock = its movements, debts = their entries) are
 * checked.
 */

const MAGIC = Buffer.from("KPBK0001");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
/** Not copied: sign-in sessions and attempt counters, and the migration records (rebuilt on restore). */
const SKIPPED_TABLES = new Set(["_prisma_migrations", "session", "verification", "rateLimit"]);
const INSERT_BATCH = 200;
export const MIN_PASSPHRASE_LENGTH = 20;

export type BackupSummary = { tables: Record<string, number>; rows: number; migrations: string[]; createdAt: string; kind: string; appVersion: string };

type Line =
  | { kuchposBackup: 1; createdAt: string; kind: string; appVersion: string; database: string; migrations: string[] }
  | { table: string; columns: string[] }
  | { r: unknown[] }
  | { end: true; tables: Record<string, number>; rows: number };

export function connectionSettings(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (url.protocol !== "mysql:" && url.protocol !== "mariadb:") throw new Error("The database address must start with mysql:// (KuchPos uses MariaDB).");
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    initSql: "SET time_zone = '+00:00'",
    // Values exactly as stored: dates as text, decimals as text, JSON as text.
    dateStrings: true,
    decimalAsNumber: false,
    bigIntAsNumber: false,
    autoJsonMap: false,
  };
}

export const databaseNameOf = (databaseUrl: string) => new URL(databaseUrl).pathname.replace(/^\//, "");

function keyFor(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`The backup passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long.`);
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/** Values in a JSON line: text, numbers and null as they are; big numbers and bytes marked. */
function encode(value: unknown): unknown {
  if (typeof value === "bigint") return { $b: value.toString() };
  if (Buffer.isBuffer(value)) return { $x: value.toString("base64") };
  return value;
}
function decode(value: unknown): unknown {
  if (value && typeof value === "object") {
    if ("$b" in value) return BigInt((value as { $b: string }).$b);
    if ("$x" in value) return Buffer.from((value as { $x: string }).$x, "base64");
  }
  return value;
}

async function tablesOf(connection: Connection): Promise<string[]> {
  const rows = await connection.query<{ name: string }[]>(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
  );
  return rows.map((row) => row.name).filter((name) => !SKIPPED_TABLES.has(name));
}

async function columnsOf(connection: Connection, table: string): Promise<string[]> {
  const rows = await connection.query<{ name: string }[]>(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%' ORDER BY ORDINAL_POSITION",
    [table],
  );
  return rows.map((row) => row.name);
}

const quote = (name: string) => `\`${name.replace(/`/g, "``")}\``;

/** Writes a backup of the whole database to `outFile`. */
export async function createBackup(options: { databaseUrl: string; passphrase: string; outFile: string; kind: string; appVersion: string }): Promise<BackupSummary> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFor(options.passphrase, salt), iv);
  const connection = await createConnection(connectionSettings(options.databaseUrl));
  const summary: BackupSummary = { tables: {}, rows: 0, migrations: [], createdAt: new Date().toISOString(), kind: options.kind, appVersion: options.appVersion };
  try {
    const records = await connection.query<{ name: string }[]>(
      "SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name",
    );
    summary.migrations = records.map((row) => row.name);
    // Every table as it stood at one moment, while the shop carries on selling.
    await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
    const tables = await tablesOf(connection);

    async function* lines(): AsyncGenerator<string> {
      const header: Line = { kuchposBackup: 1, createdAt: summary.createdAt, kind: options.kind, appVersion: options.appVersion, database: databaseNameOf(options.databaseUrl), migrations: summary.migrations };
      yield `${JSON.stringify(header)}\n`;
      for (const table of tables) {
        const columns = await columnsOf(connection, table);
        yield `${JSON.stringify({ table, columns } satisfies Line)}\n`;
        let count = 0;
        const stream = connection.queryStream({ sql: `SELECT ${columns.map(quote).join(", ")} FROM ${quote(table)}`, rowsAsArray: true });
        for await (const row of stream as AsyncIterable<unknown[]>) {
          count += 1;
          yield `${JSON.stringify({ r: row.map(encode) })}\n`;
        }
        summary.tables[table] = count;
        summary.rows += count;
      }
      yield `${JSON.stringify({ end: true, tables: summary.tables, rows: summary.rows } satisfies Line)}\n`;
    }

    const file = createWriteStream(options.outFile);
    file.write(Buffer.concat([MAGIC, salt, iv]));
    await pipeline(Readable.from(lines()), createGzip(), cipher, file);
    await connection.query("COMMIT");
  } finally {
    await connection.end();
  }
  const handle = await open(options.outFile, "a");
  await handle.write(cipher.getAuthTag());
  await handle.close();
  return summary;
}

/** Reads a backup file line by line, decrypted. The file's seal is checked when the last line has been read. */
async function* readLines(file: string, passphrase: string): AsyncGenerator<Line> {
  const size = (await stat(file)).size;
  if (size < HEADER_BYTES + TAG_BYTES) throw new Error("This is not a KuchPos backup file (it is too small).");
  const handle = await open(file, "r");
  const head = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  await handle.read(head, 0, HEADER_BYTES, 0);
  await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  await handle.close();
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("This is not a KuchPos backup file.");
  const salt = head.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = head.subarray(MAGIC.length + SALT_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyFor(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  const gunzip = createGunzip();
  const source = createReadStream(file, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 });
  const failed: { error: unknown } = { error: null };
  const done = pipeline(source, decipher, gunzip).catch((error: unknown) => {
    failed.error = error;
  });
  try {
    for await (const text of createInterface({ input: gunzip, crlfDelay: Number.POSITIVE_INFINITY })) {
      if (text) yield JSON.parse(text) as Line;
    }
    await done;
  } catch (error) {
    failed.error ??= error;
  }
  if (failed.error) throw new Error("This backup could not be opened: the passphrase is wrong, or the file is damaged or incomplete.");
}

/** Reads the whole file once: is it complete and genuine, and what is in it? Nothing is changed. */
export async function checkBackup(file: string, passphrase: string): Promise<BackupSummary> {
  let header: Extract<Line, { kuchposBackup: 1 }> | null = null;
  let footer: Extract<Line, { end: true }> | null = null;
  const counted: Record<string, number> = {};
  let table = "";
  for await (const line of readLines(file, passphrase)) {
    if ("kuchposBackup" in line) header = line;
    else if ("table" in line) {
      table = line.table;
      counted[table] = 0;
    } else if ("r" in line) counted[table] += 1;
    else if ("end" in line) footer = line;
  }
  if (!header || !footer) throw new Error("This backup is incomplete.");
  for (const [name, count] of Object.entries(footer.tables)) {
    if (counted[name] !== count) throw new Error(`This backup is incomplete: table ${name} should have ${count} rows.`);
  }
  return { tables: footer.tables, rows: footer.rows, migrations: header.migrations, createdAt: header.createdAt, kind: header.kind, appVersion: header.appVersion };
}

export type RestoreReport = BackupSummary & { checks: { name: string; problems: number }[] };

/**
 * Loads a backup into the database at `targetUrl`, which is EMPTIED first. Refuses unless
 * the target's name contains "restore" and is not `protectedUrl`'s database (the one the
 * app uses).
 */
export async function restoreBackup(options: {
  file: string;
  passphrase: string;
  targetUrl: string;
  protectedUrl?: string;
  migrationsDir: string;
  log?: (message: string) => void;
}): Promise<RestoreReport> {
  const log = options.log ?? (() => {});
  const target = databaseNameOf(options.targetUrl);
  if (!/restore/i.test(target)) throw new Error(`Refusing to restore into "${target}": the database for a restore must have "restore" in its name.`);
  if (options.protectedUrl && databaseNameOf(options.protectedUrl) === target) throw new Error(`Refusing to restore into "${target}": it is the database the app is using.`);

  log("Checking the backup file from end to end …");
  const summary = await checkBackup(options.file, options.passphrase);
  log(`The file is complete: made ${summary.createdAt}, ${Object.keys(summary.tables).length} tables, ${summary.rows} rows.`);

  const available = existsSync(options.migrationsDir) ? readdirSync(options.migrationsDir).sort() : [];
  const missing = summary.migrations.filter((name) => !available.includes(name));
  if (missing.length > 0) throw new Error(`This backup was made by a newer version of KuchPos (${missing[0]}). Upload that version first, then restore.`);

  const connection = await createConnection({ ...connectionSettings(options.targetUrl), multipleStatements: true });
  try {
    log(`Emptying "${target}" …`);
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of await connection.query<{ name: string }[]>("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()")) {
      await connection.query(`DROP TABLE IF EXISTS ${quote(table.name)}`);
    }
    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    await connection.end();
  }

  log("Rebuilding the database structure as it was when the backup was made …");
  await applyMigrations({ databaseUrl: options.targetUrl, migrationsDir: options.migrationsDir, upTo: summary.migrations.at(-1) ?? "" });

  log("Loading the records …");
  const loader = await createConnection(connectionSettings(options.targetUrl));
  try {
    await loader.query("SET FOREIGN_KEY_CHECKS = 0");
    await loader.beginTransaction();
    let table = "";
    let columns: string[] = [];
    let batch: unknown[][] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const row = `(${columns.map(() => "?").join(", ")})`;
      await loader.query(`INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES ${batch.map(() => row).join(", ")}`, batch.flat());
      batch = [];
    };
    for await (const line of readLines(options.file, options.passphrase)) {
      if ("table" in line) {
        await flush();
        table = line.table;
        columns = line.columns;
      } else if ("r" in line) {
        batch.push(line.r.map(decode));
        if (batch.length >= INSERT_BATCH) await flush();
      }
    }
    await flush();
    await loader.commit();
    await loader.query("SET FOREIGN_KEY_CHECKS = 1");

    for (const [name, count] of Object.entries(summary.tables)) {
      const [row] = await loader.query<{ n: bigint | number }[]>(`SELECT COUNT(*) AS n FROM ${quote(name)}`);
      if (Number(row.n) !== count) throw new Error(`After loading, table ${name} has ${row.n} rows instead of ${count}.`);
    }
  } finally {
    await loader.end();
  }

  const later = await applyMigrations({ databaseUrl: options.targetUrl, migrationsDir: options.migrationsDir });
  if (later.applied.length > 0) log(`Brought up to this version of KuchPos: ${later.applied.join(", ")}.`);

  log("Checking the records …");
  const checker = await createConnection(connectionSettings(options.targetUrl));
  try {
    const checks = [];
    for (const [name, sql] of RULES) {
      const [row] = await checker.query<{ n: bigint | number }[]>(sql);
      checks.push({ name, problems: Number(row.n) });
    }
    return { ...summary, checks };
  } finally {
    await checker.end();
  }
}

/** KuchPos's own rules, each counted as "how many records break it". All must be 0. */
const RULES: [string, string][] = [
  [
    "Stock on hand equals the sum of its movements",
    `SELECT COUNT(*) AS n FROM (
       SELECT k.productId, k.locationId FROM (
         SELECT productId, locationId FROM stock_balance UNION SELECT productId, locationId FROM stock_movement
       ) k
       LEFT JOIN stock_balance b ON b.productId = k.productId AND b.locationId = k.locationId
       LEFT JOIN (SELECT productId, locationId, SUM(quantityDelta) AS q FROM stock_movement GROUP BY productId, locationId) m
         ON m.productId = k.productId AND m.locationId = k.locationId
       WHERE COALESCE(b.quantity, 0) <> COALESCE(m.q, 0)
     ) wrong`,
  ],
  [
    "Each customer's debt equals the sum of their account entries",
    `SELECT COUNT(*) AS n FROM customer c
       LEFT JOIN (SELECT customerId, SUM(amount) AS total FROM customer_account_entry GROUP BY customerId) e ON e.customerId = c.id
     WHERE c.balance <> COALESCE(e.total, 0)`,
  ],
];
