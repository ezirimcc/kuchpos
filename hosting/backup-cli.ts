import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConnection } from "mariadb";
import { b2Authorize, b2Upload } from "./b2";
import { connectionSettings, createBackup, MIN_PASSPHRASE_LENGTH } from "./backup-core";
import { databaseAddress, lagosMonth, loadToolEnv, required } from "./tool-env";

/**
 * KuchPos's own backup (C79). Run by the host's Cron Jobs from the application folder:
 *   node tools/backup.cjs daytime     (every 2 hours, 8 am to 8 pm Lagos time)
 *   node tools/backup.cjs nightly     (once a night)
 * Makes one encrypted file in ./backups (the newest 12 are kept there), sends it to Backblaze
 * B2 under daytime/ or nightly/ — and the first nightly copy of each month also under
 * monthly/ — and records the run in `backup_run` for the owner's Backups page.
 */
const KEEP_ON_SERVER = 12;

async function main() {
  const kind = process.argv[2];
  if (kind !== "daytime" && kind !== "nightly") throw new Error('Say which backup: "daytime" or "nightly".');
  const { site, appVersion } = loadToolEnv();
  const databaseUrl = databaseAddress("DATABASE_URL");
  const passphrase = required("BACKUP_PASSPHRASE", `Choose a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters and keep a copy in your password manager.`);

  const db = await createConnection(connectionSettings(databaseUrl));
  const runId = randomUUID();
  await db.query("INSERT INTO backup_run (id, kind, startedAt) VALUES (?, ?, UTC_TIMESTAMP(3))", [runId, kind]);
  const problems: string[] = [];
  try {
    const folder = resolve(process.cwd(), "backups");
    mkdirSync(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
    const fileName = `kuchpos-${site}-${stamp}Z-${kind}.kbk`;
    const path = join(folder, fileName);
    const summary = await createBackup({ databaseUrl, passphrase, outFile: path, kind, appVersion });
    const sizeBytes = statSync(path).size;
    await db.query("UPDATE backup_run SET fileName = ?, sizeBytes = ?, tableCount = ?, rowCount = ? WHERE id = ?", [fileName, sizeBytes, Object.keys(summary.tables).length, summary.rows, runId]);
    console.log(`Backup made: ${fileName} (${(sizeBytes / 1024).toFixed(0)} KB, ${summary.rows} records).`);

    // Off the server: the owner's Backblaze B2 bucket.
    let uploaded = false;
    let monthly = false;
    if (process.env.B2_KEY_ID && process.env.B2_APPLICATION_KEY) {
      try {
        const session = await b2Authorize(process.env.B2_KEY_ID, process.env.B2_APPLICATION_KEY);
        await b2Upload(session, path, `${kind}/${fileName}`);
        uploaded = true;
        if (kind === "nightly") {
          const [{ n }] = await db.query<{ n: bigint | number }[]>(
            "SELECT COUNT(*) AS n FROM backup_run WHERE monthly = TRUE AND uploadedAt IS NOT NULL AND DATE_FORMAT(DATE_ADD(startedAt, INTERVAL 1 HOUR), '%Y-%m') = ?",
            [lagosMonth()],
          );
          if (Number(n) === 0) {
            await b2Upload(session, path, `monthly/${fileName}`);
            monthly = true;
          }
        }
        console.log(`Sent to Backblaze B2${monthly ? " (also kept as this month's copy)" : ""}.`);
      } catch (error) {
        problems.push(`Not sent to Backblaze B2: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      problems.push("Not sent to Backblaze B2: B2_KEY_ID and B2_APPLICATION_KEY are not set in the .env file.");
    }
    await db.query("UPDATE backup_run SET uploadedAt = IF(?, UTC_TIMESTAMP(3), NULL), monthly = ? WHERE id = ?", [uploaded, monthly, runId]);

    // Only the newest copies stay on the server.
    const kept = readdirSync(folder)
      .filter((name) => name.endsWith(".kbk") && name.startsWith("kuchpos-"))
      .sort()
      .reverse();
    for (const old of kept.slice(KEEP_ON_SERVER)) rmSync(join(folder, old), { force: true });
  } catch (error) {
    problems.push(`The backup failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.query("UPDATE backup_run SET finishedAt = UTC_TIMESTAMP(3), problem = ? WHERE id = ?", [problems.length ? problems.join(" ").slice(0, 1000) : null, runId]);
    await db.end();
  }
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
