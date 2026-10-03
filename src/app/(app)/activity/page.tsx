import { History } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ActivityTable } from "@/components/activity-table";
import { FilterDate, LiveSearch } from "@/components/filters";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/pagination";
import { requirePagePermission } from "@/server/auth/request";
import { listActivity } from "@/server/business/activity-log";

export const metadata: Metadata = { title: "Activity log — KuchPos" };

function text(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  const context = await requirePagePermission("activityLog.view");
  const params = await searchParams;
  const filters = { q: text(params.q), from: text(params.from), to: text(params.to) };
  const list = await listActivity(context, {
    search: filters.q,
    from: filters.from,
    to: filters.to,
    page: text(params.page),
  });
  const filtered = Object.values(filters).some((value) => value !== "");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={History}
        title="Activity log"
        description={`Who did what in ${context.business?.name}, newest first. Entries can never be changed or removed.`}
      />

      <Suspense>
        <div className="flex flex-wrap items-center gap-3">
          <LiveSearch label="Search the activity log" placeholder="Search by person, product, unit or any word" />
          <FilterDate name="from" label="From" />
          <FilterDate name="to" label="To" />
          {filtered && (
            <Link href="/activity" className="text-sm text-link underline-offset-4 hover:underline">
              Clear filters
            </Link>
          )}
        </div>
      </Suspense>

      {list.entries.length === 0 ? (
        <p className="rounded-3xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {filtered ? "Nothing matches these filters." : "Nothing has been recorded yet."}
        </p>
      ) : (
        <ActivityTable entries={list.entries} />
      )}

      <Pagination path="/activity" params={filters} noun="entries" {...list} />
    </div>
  );
}
