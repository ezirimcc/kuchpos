import "server-only";
import type { AppContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { PAGE_SIZE, type Paged, paged, pageNumber } from "@/server/paging";
import { authorize } from "@/server/permissions";

/**
 * KuchPos's own backups as the owner sees them (C79): each run of the backup tool on the
 * hosting server (`hosting/backup-cli.ts`, table `backup_run`), and a plain warning when
 * backups have stopped reaching Backblaze B2. About the whole system, so it lives here beside
 * the System check.
 */

const KEEP_DAYS = 400;
/** A nightly copy is expected every night: after this long without one in B2, the owner is warned. */
const STALE_HOURS = 26;

export type BackupRunRow = {
  id: string;
  kind: string;
  startedAt: Date;
  finishedAt: Date | null;
  fileName: string | null;
  sizeBytes: number | null;
  rowCount: number | null;
  uploadedAt: Date | null;
  monthly: boolean;
  problem: string | null;
};

export type BackupHealth = {
  /** Has the backup tool ever run here? */
  everRun: boolean;
  lastUploadedAt: Date | null;
  /** A plain warning, or null when all is well. */
  warning: string | null;
};

async function backupHealth(): Promise<BackupHealth> {
  const db = getDb();
  const [any, uploaded, latest] = await Promise.all([
    db.backupRun.count(),
    db.backupRun.findFirst({ where: { uploadedAt: { not: null }, problem: null }, orderBy: { uploadedAt: "desc" }, select: { uploadedAt: true } }),
    db.backupRun.findFirst({ where: { finishedAt: { not: null } }, orderBy: { startedAt: "desc" }, select: { problem: true, startedAt: true } }),
  ]);
  const lastUploadedAt = uploaded?.uploadedAt ?? null;
  let warning: string | null = null;
  if (any === 0) warning = "No backup has been made on this server yet. Set up the backup jobs (see DEPLOY.md).";
  else if (!lastUploadedAt || Date.now() - lastUploadedAt.getTime() > STALE_HOURS * 60 * 60 * 1000) {
    warning = `No backup has reached Backblaze B2 in the last ${STALE_HOURS} hours. Look at the latest runs below.`;
  } else if (latest?.problem) warning = `The latest backup had a problem: ${latest.problem}`;
  return { everRun: any > 0, lastUploadedAt, warning };
}

/** Backup runs, newest first. Runs older than 400 days are cleared as the list is read. */
export async function listBackupRuns(context: AppContext, input: { page?: string } = {}): Promise<{ rows: BackupRunRow[]; health: BackupHealth } & Paged> {
  authorize(context, "owner.manage");
  const db = getDb();
  await db.backupRun.deleteMany({ where: { startedAt: { lt: new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000) } } });
  const page = pageNumber.parse(input.page);
  const [total, rows, health] = await Promise.all([
    db.backupRun.count(),
    db.backupRun.findMany({ orderBy: [{ startedAt: "desc" }, { id: "desc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    backupHealth(),
  ]);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      rowCount: row.rowCount,
      uploadedAt: row.uploadedAt,
      monthly: row.monthly,
      problem: row.problem,
    })),
    health,
    ...paged(total, page),
  };
}
