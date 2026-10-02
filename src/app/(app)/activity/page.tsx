import type { Metadata } from "next";
import { ActivityTable } from "@/components/activity-table";
import { requirePagePermission } from "@/server/auth/request";
import { listActivity } from "@/server/business/activity-log";

export const metadata: Metadata = { title: "Activity log — KuchPos" };

export default async function ActivityPage() {
  const context = await requirePagePermission("activityLog.view");
  const entries = await listActivity(context);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity log</h1>
        <p className="text-sm text-muted-foreground">
          Who did what in {context.business?.name}, newest first. Entries can never be changed or removed.
        </p>
      </div>
      <ActivityTable entries={entries} />
    </div>
  );
}
