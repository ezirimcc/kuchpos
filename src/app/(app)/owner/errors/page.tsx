import { Bug } from "lucide-react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { requirePagePermission } from "@/server/auth/request";
import { listErrors } from "@/server/platform/error-log";

export const metadata: Metadata = { title: "Error log — KuchPos" };

const KINDS: Record<string, string> = {
  action: "While saving",
  request: "While a screen was checking for news",
  page: "While opening a screen",
  route: "While answering a request",
};

export default async function ErrorLogPage({ searchParams }: PageProps<"/owner/errors">) {
  const context = await requirePagePermission("owner.manage");
  const params = await searchParams;
  const list = await listErrors(context, { page: typeof params.page === "string" ? params.page : undefined });

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        icon={Bug}
        title="Error log"
        description="Each time something went wrong unexpectedly, in any business, it is noted here. Staff only saw a plain message; the technical details below are for whoever maintains the app. Entries are cleared after 90 days."
      />
      <p className="text-sm" data-testid="errors-summary">
        {list.total === 0
          ? "Nothing has gone wrong in the last 90 days."
          : `${list.last24Hours} in the last 24 hours, ${list.total} in the last 90 days.`}
      </p>
      {list.rows.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">No errors on record.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {list.rows.map((row) => (
            <Card key={row.id} data-testid="error-row">
              <CardContent className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">{formatDateTime(row.at)}</p>
                  <p className="text-sm text-muted-foreground">
                    {KINDS[row.kind] ?? row.kind}
                    {row.userName ? ` · ${row.userName}` : ""}
                    {row.businessName ? ` · ${row.businessName}` : ""}
                    {row.appVersion ? ` · version ${row.appVersion}` : ""}
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">{row.place}</p>
                <p className="text-sm break-words">{row.message}</p>
                {row.digest && <p className="text-xs text-muted-foreground">Code shown to the person: {row.digest}</p>}
                {row.detail && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-link">Technical details</summary>
                    <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-muted p-3 whitespace-pre-wrap">{row.detail}</pre>
                  </details>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Pagination path="/owner/errors" params={{}} noun="entries" page={list.page} pageCount={list.pageCount} total={list.total} pageSize={list.pageSize} />
    </div>
  );
}
