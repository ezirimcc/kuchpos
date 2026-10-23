import { requirePageContext, requirePagePermission } from "@/server/auth/request";
import { can } from "@/server/permissions";

/**
 * Every Reports page needs the permission to open Reports as well as its own report's (C70):
 * a manager holds several of the reports' permissions for other screens, but not this one.
 * A manager may open the Sales and Collections reports for the last 7 days only (C82): those
 * two pages let them in, every other Reports page asks for the full permission itself.
 * (This only sends people away from the screens; each report checks again on the server.)
 */
export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  const context = await requirePageContext();
  if (!can(context, "report.pages.view")) await requirePagePermission("report.recent.view");
  return children;
}
