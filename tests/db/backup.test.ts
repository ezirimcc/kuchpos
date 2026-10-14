import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postSale } from "@/server/business/sales";
import { receiveGoods } from "@/server/business/stock";
import { openTill } from "@/server/business/till";
import { getDb } from "@/server/db/client";
import { checkBackup, createBackup, restoreBackup } from "../../hosting/backup-core";
import { applyMigrations } from "../../hosting/migrate";
import { createWorld, expectBalancesMatchMovements, type World } from "../support/world";

/**
 * KuchPos's own backups (C79): a backup taken from the test database and loaded into a spare
 * database must give back exactly the same records, and pass KuchPos's own checks. A wrong
 * passphrase, a damaged file, or a target that is not a spare database must be refused
 * before anything is emptied.
 */
// Each restore applies every migration from the beginning.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const RESTORE = "kuchpos_test_restore";
const urlFor = (database: string) => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${database}`;
  return url.toString();
};
const sourceUrl = process.env.DATABASE_URL ?? "";
const restoreUrl = urlFor(RESTORE);
const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const PASSPHRASE = "a long passphrase for the test backups";
const folder = mkdtempSync(join(tmpdir(), "kuchpos-backup-"));

let world: World;

beforeEach(async () => {
  world = await createWorld();
  await getDb().$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${RESTORE}\``);
  await getDb().$executeRawUnsafe(`CREATE DATABASE \`${RESTORE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  // Some trading to back up: a delivery and a sale.
  await receiveGoods(world.a.as.ADMIN, {
    requestId: randomUUID(),
    supplierId: world.a.supplierId,
    locationId: world.a.shelfId,
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "10", unitCost: "50" }],
  });
  await openTill(world.a.as.CASHIER, { terminalId: world.a.terminalId, openingFloat: "0" });
  await postSale(world.a.as.CASHIER, {
    requestId: randomUUID(),
    terminalId: world.a.terminalId,
    expectedTotal: "100.00",
    payments: [{ methodId: world.a.cashMethodId, amount: "100.00" }],
    lines: [{ productId: world.a.product.id, unitId: world.a.product.baseUnitId, quantity: "1", unitPrice: "100.00" }],
  });
});

afterEach(async () => {
  await expectBalancesMatchMovements();
});

afterAll(async () => {
  await getDb().$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${RESTORE}\``);
});

const backup = async (name = "test.kbk") => {
  const file = join(folder, name);
  return { file, summary: await createBackup({ databaseUrl: sourceUrl, passphrase: PASSPHRASE, outFile: file, kind: "nightly", appVersion: "test" }) };
};

/** A fingerprint of every row of a table, in the same order on both sides. */
async function tableChecksums(database: string, tables: string[]): Promise<Record<string, string>> {
  const sums: Record<string, string> = {};
  for (const table of tables) {
    const [row] = await getDb().$queryRawUnsafe<{ Checksum: bigint | null }[]>(`CHECKSUM TABLE \`${database}\`.\`${table}\` EXTENDED`);
    sums[table] = String(row.Checksum);
  }
  return sums;
}

describe("a backup", () => {
  it("holds every table except sign-in sessions, and its counts are the database's", async () => {
    const { file, summary } = await backup();
    expect(readFileSync(file).subarray(0, 8).toString()).toBe("KPBK0001");
    // Nothing readable inside without the passphrase.
    expect(readFileSync(file).includes(Buffer.from("Test a.cashier"))).toBe(false);
    expect(summary.tables).not.toHaveProperty("session");
    expect(summary.tables).not.toHaveProperty("_prisma_migrations");
    expect(summary.tables.sale).toBe(1);
    expect(summary.tables.stock_movement).toBe(await getDb().stockMovement.count());
    expect(summary.tables.user).toBe(await getDb().user.count());
    expect(summary.migrations.length).toBeGreaterThan(10);
    expect(await checkBackup(file, PASSPHRASE)).toMatchObject({ rows: summary.rows, tables: summary.tables, kind: "nightly" });
  });

  it("loads back into a spare database exactly as it was, and passes KuchPos's own checks", async () => {
    const { file, summary } = await backup();
    const log: string[] = [];
    const report = await restoreBackup({ file, passphrase: PASSPHRASE, targetUrl: restoreUrl, protectedUrl: sourceUrl, migrationsDir: MIGRATIONS, log: (line) => log.push(line) });
    expect(report.rows).toBe(summary.rows);
    expect(report.checks.map((check) => check.problems)).toEqual(report.checks.map(() => 0));
    expect(log[0]).toMatch(/Checking the backup file/);

    const source = new URL(sourceUrl).pathname.slice(1);
    const tables = Object.keys(summary.tables);
    expect(await tableChecksums(RESTORE, tables)).toEqual(await tableChecksums(source, tables));
    // The structure, its triggers and limits included, is that of the migrations.
    const [{ n }] = await getDb().$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${RESTORE}'`);
    const [{ m }] = await getDb().$queryRawUnsafe<{ m: bigint }[]>(`SELECT COUNT(*) AS m FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${source}'`);
    expect(Number(n)).toBe(Number(m));
  });

  it("can be loaded again over an earlier restore", async () => {
    const { file, summary } = await backup();
    await restoreBackup({ file, passphrase: PASSPHRASE, targetUrl: restoreUrl, protectedUrl: sourceUrl, migrationsDir: MIGRATIONS });
    expect((await restoreBackup({ file, passphrase: PASSPHRASE, targetUrl: restoreUrl, protectedUrl: sourceUrl, migrationsDir: MIGRATIONS })).rows).toBe(summary.rows);
  });

  it("is refused with a wrong passphrase, or damaged, or cut short — before the spare database is touched", async () => {
    const { file } = await backup();
    await getDb().$executeRawUnsafe(`CREATE TABLE \`${RESTORE}\`.\`marker\` (id INT)`);
    const restore = (path: string, passphrase = PASSPHRASE) => restoreBackup({ file: path, passphrase, targetUrl: restoreUrl, protectedUrl: sourceUrl, migrationsDir: MIGRATIONS });

    await expect(restore(file, "not the right passphrase at all")).rejects.toThrow(/passphrase is wrong, or the file is damaged/);
    const bytes = readFileSync(file);
    const damaged = Buffer.from(bytes);
    damaged[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(join(folder, "damaged.kbk"), damaged);
    await expect(restore(join(folder, "damaged.kbk"))).rejects.toThrow(/damaged or incomplete/);
    writeFileSync(join(folder, "short.kbk"), bytes.subarray(0, Math.floor(bytes.length * 0.7)));
    await expect(restore(join(folder, "short.kbk"))).rejects.toThrow(/damaged or incomplete/);
    writeFileSync(join(folder, "other.kbk"), "hello");
    await expect(restore(join(folder, "other.kbk"))).rejects.toThrow(/not a KuchPos backup/);

    // The spare database was never emptied.
    const [{ n }] = await getDb().$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${RESTORE}' AND TABLE_NAME = 'marker'`);
    expect(Number(n)).toBe(1);
  });

  it("is never loaded into the database the app uses, or any database without \"restore\" in its name", async () => {
    const { file } = await backup();
    await expect(restoreBackup({ file, passphrase: PASSPHRASE, targetUrl: sourceUrl, migrationsDir: MIGRATIONS })).rejects.toThrow(/must have "restore" in its name/);
    await expect(restoreBackup({ file, passphrase: PASSPHRASE, targetUrl: restoreUrl, protectedUrl: restoreUrl, migrationsDir: MIGRATIONS })).rejects.toThrow(/the database the app is using/);
    await expect(createBackup({ databaseUrl: sourceUrl, passphrase: "too short", outFile: join(folder, "x.kbk"), kind: "nightly", appVersion: "test" })).rejects.toThrow(/at least 20 characters/);
  });

  it("made by a newer KuchPos is refused by an older one; one made by an older KuchPos is brought up to date", async () => {
    const { file } = await backup();
    const older = mkdtempSync(join(tmpdir(), "kuchpos-migrations-"));
    await expect(restoreBackup({ file, passphrase: PASSPHRASE, targetUrl: restoreUrl, protectedUrl: sourceUrl, migrationsDir: older })).rejects.toThrow(/made by a newer version/);

    // "Only up to" a migration leaves the later ones for afterwards.
    const all = (await applyMigrations({ databaseUrl: restoreUrl, migrationsDir: MIGRATIONS, upTo: "20261002000000" })).applied;
    expect(all.every((name) => name <= "20261002000000")).toBe(true);
  });
});

describe("the owner's Backups page", () => {
  it("warns until a backup has reached Backblaze B2, then says backups are working; owners only", async () => {
    const { listBackupRuns } = await import("@/server/platform/backups");
    const { ForbiddenError } = await import("@/server/errors");
    expect((await listBackupRuns(world.ownerOutside)).health.warning).toMatch(/No backup has been made/);

    await getDb().backupRun.create({ data: { kind: "nightly", finishedAt: new Date(), fileName: "a.kbk", problem: "Not sent to Backblaze B2: B2_KEY_ID and B2_APPLICATION_KEY are not set in the .env file." } });
    expect((await listBackupRuns(world.ownerOutside)).health.warning).toMatch(/No backup has reached Backblaze B2 in the last 26 hours/);

    await getDb().backupRun.create({ data: { kind: "daytime", finishedAt: new Date(), fileName: "b.kbk", uploadedAt: new Date(), sizeBytes: 2048, rowCount: 100 } });
    const list = await listBackupRuns(world.ownerOutside);
    expect(list.health).toMatchObject({ everRun: true, warning: null });
    expect(list.rows.map((row) => row.fileName)).toEqual(["b.kbk", "a.kbk"]);
    await expect(listBackupRuns(world.a.as.ADMIN)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
