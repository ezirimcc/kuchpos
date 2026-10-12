import { requirePagePermission } from "@/server/auth/request";

/**
 * Every Reports page needs the permission to open Reports as well as its own report's (C70):
 * a manager holds several of the reports' permissions for other screens, but not this one.
 * (This only sends people away from the screens; each report checks again on the server.)
 */
export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  await requirePagePermission("report.pages.view");
  return children;
}
