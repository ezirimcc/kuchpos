import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { b2Authorize, b2Download, b2List } from "./b2";
import { restoreBackup } from "./backup-core";
import { loadToolEnv, required } from "./tool-env";

/**
 * Loads a backup into the spare database named by RESTORE_DATABASE_URL (C79) and checks it.
 * Run with "Run JS script" → restore. It never touches the database the app uses.
 *
 * Which backup: RESTORE_FILE if set (a name in ./backups, or a name stored in Backblaze B2 such
 * as "nightly/kuchpos-live-….kbk"); otherwise the newest copy in Backblaze B2 — fetching it
 * back is part of the drill — or, if B2 is not set up, the newest copy on the server.
 */
async function main() {
  loadToolEnv();
  const passphrase = required("BACKUP_PASSPHRASE", "It is the passphrase the backups were made with.");
  const targetUrl = required("RESTORE_DATABASE_URL", 'Create a spare database with "restore" in its name and put its address here.');
  const folder = resolve(process.cwd(), "backups");
  const local = (name: string) => join(folder, name.split("/").at(-1)!);
  const b2 = process.env.B2_KEY_ID && process.env.B2_APPLICATION_KEY ? await b2Authorize(process.env.B2_KEY_ID, process.env.B2_APPLICATION_KEY) : null;

  let file: string;
  let fetched = false;
  const wanted = process.env.RESTORE_FILE?.trim();
  if (wanted && existsSync(local(wanted)) && !wanted.includes("/")) {
    file = local(wanted);
  } else if (wanted || b2) {
    if (!b2) throw new Error("That backup is not on the server, and Backblaze B2 is not set up in the .env file.");
    let name = wanted;
    if (!name) {
      const files = await b2List(b2, ["daytime/", "nightly/", "monthly/"]);
      const newest = files.sort((a, b) => b.uploadTimestamp - a.uploadTimestamp)[0];
      if (!newest) throw new Error("There are no backups in Backblaze B2 yet.");
      name = newest.fileName;
    }
    file = join(folder, `fetched-${name.split("/").at(-1)}`);
    console.log(`Fetching ${name} back from Backblaze B2 …`);
    await b2Download(b2, name, file);
    fetched = true;
  } else {
    const newest = existsSync(folder) ? readdirSync(folder).filter((name) => name.startsWith("kuchpos-") && name.endsWith(".kbk")).sort().at(-1) : undefined;
    if (!newest) throw new Error("There are no backups on the server yet.");
    file = join(folder, newest);
    console.log("Backblaze B2 is not set up, so the newest copy on the server is used.");
  }

  try {
    const report = await restoreBackup({
      file,
      passphrase,
      targetUrl,
      protectedUrl: process.env.DATABASE_URL,
      migrationsDir: resolve(process.cwd(), "migrations"),
      log: (message) => console.log(message),
    });
    console.log("");
    console.log(`Backup made: ${report.createdAt} (${report.kind}, KuchPos ${report.appVersion})`);
    console.log(`Records loaded: ${report.rows} in ${Object.keys(report.tables).length} tables`);
    for (const check of report.checks) console.log(`${check.problems === 0 ? "OK  " : "FAIL"}  ${check.name}${check.problems ? ` (${check.problems} wrong)` : ""}`);
    if (report.checks.some((check) => check.problems > 0)) {
      console.log("\nRESTORE FINISHED WITH PROBLEMS — see the lines marked FAIL.");
      process.exit(1);
    }
    console.log("\nRESTORE DRILL PASSED.");
  } finally {
    if (fetched) rmSync(file, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
