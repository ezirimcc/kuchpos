import { DatabaseBackup } from "lucide-react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listBackupRuns } from "@/server/platform/backups";

export const metadata: Metadata = { title: "Backups — KuchPos" };

const KINDS: Record<string, string> = { daytime: "Every 2 hours", nightly: "Nightly" };

const size = (bytes: number | null) => (bytes === null ? "—" : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** KuchPos's own backups (C79), for owners: each run, and whether it reached Backblaze B2. */
export default async function BackupsPage({ searchParams }: PageProps<"/owner/backups">) {
  const context = await requirePagePermission("owner.manage");
  const params = await searchParams;
  const list = await listBackupRuns(context, { page: typeof params.page === "string" ? params.page : undefined });

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        icon={DatabaseBackup}
        title="Backups"
        description="KuchPos copies all its records every 2 hours while the shops are open and once every night, locks each copy with the backup passphrase, and sends it to your Backblaze B2 storage. This is besides the hosting company's own daily backups."
      />
      {list.health.warning ? (
        <Alert variant="destructive" data-testid="backup-warning">
          {list.health.warning}
        </Alert>
      ) : (
        <Alert variant="success" data-testid="backup-ok">
          Backups are working. The last copy reached Backblaze B2 on {formatDateTime(list.health.lastUploadedAt!)}.
        </Alert>
      )}
      {list.rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Records</TableHead>
              <TableHead>Backblaze B2</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.rows.map((row) => (
              <TableRow key={row.id} data-testid="backup-row">
                <TableCell className="whitespace-nowrap">{formatDateTime(row.startedAt)}</TableCell>
                <TableCell>
                  {KINDS[row.kind] ?? row.kind}
                  {row.monthly && (
                    <Badge variant="secondary" className="ml-2">
                      Kept as this month&apos;s copy
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{size(row.sizeBytes)}</TableCell>
                <TableCell className="text-right tabular-nums">{row.rowCount?.toLocaleString("en-NG") ?? "—"}</TableCell>
                <TableCell>
                  {row.finishedAt === null ? (
                    <span className="text-muted-foreground">Still running…</span>
                  ) : row.uploadedAt && !row.problem ? (
                    <Badge variant="success">Stored</Badge>
                  ) : (
                    <span className="text-sm text-destructive">{row.problem ?? "Not stored"}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Pagination path="/owner/backups" params={{}} noun="backups" page={list.page} pageCount={list.pageCount} total={list.total} pageSize={list.pageSize} />
    </div>
  );
}
