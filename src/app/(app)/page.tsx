import {
  ArrowUpRight,
  Boxes,
  ChartColumn,
  HandCoins,
  History,
  type LucideIcon,
  Package,
  Percent,
  Settings,
  ShoppingCart,
  Tags,
  UserCog,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatDateTime, nairaFromText, plainNumber, shopGreeting } from "@/lib/format";
import { requirePageContext } from "@/server/auth/request";
import { getDashboard } from "@/server/business/dashboard";
import { can, type Permission, ROLE_LABELS } from "@/server/permissions";

const SHORTCUTS: { href: string; title: string; text: string; icon: LucideIcon; needs: Permission }[] = [
  { href: "/sell", title: "Sell", text: "Start a sale at the checkout.", icon: ShoppingCart, needs: "sale.create" },
  { href: "/products", title: "Products & Categories", text: "Look up a price, or add and change products.", icon: Package, needs: "price.view" },
  { href: "/staff", title: "Staff", text: "Add people and set what they can do.", icon: UserCog, needs: "staff.manage" },
  { href: "/activity", title: "Activity log", text: "See who did what, and when.", icon: History, needs: "activityLog.view" },
  { href: "/settings", title: "Settings", text: "Tax rate, receipts, terminals and sign-out time.", icon: Settings, needs: "settings.manage" },
];

// Figures that will appear here as each part of KuchPos is built.
const COMING: { title: string; icon: LucideIcon; needs: Permission }[] = [
  { title: "Owed by customers", icon: HandCoins, needs: "report.customerDebt.view" },
];

function Stat({
  title,
  value,
  note,
  icon: Icon,
  highlight = false,
  testId,
}: {
  title: string;
  value: string;
  note: string;
  icon: LucideIcon;
  highlight?: boolean;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className={
        highlight
          ? "bg-brand-gradient flex flex-col gap-4 rounded-3xl p-5 text-white shadow-sm"
          : "flex flex-col gap-4 rounded-3xl bg-card p-5 dark:border dark:border-border"
      }
    >
      <div className="flex items-center justify-between">
        <span className={highlight ? "text-sm text-white/85" : "text-sm text-muted-foreground"}>{title}</span>
        <span
          className={
            highlight
              ? "flex size-9 items-center justify-center rounded-full bg-white/15"
              : "flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"
          }
        >
          <Icon className="size-4" aria-hidden />
        </span>
      </div>
      <div>
        <p className="text-3xl font-semibold tracking-tight">{value}</p>
        <p className={highlight ? "mt-1 text-xs text-white/75" : "mt-1 text-xs text-muted-foreground"}>{note}</p>
      </div>
    </div>
  );
}

export default async function HomePage() {
  const context = await requirePageContext();
  // An owner with no business open starts at the list of businesses.
  if (!context.business) redirect("/owner/businesses");

  const snapshot = await getDashboard(context);
  const shortcuts = SHORTCUTS.filter((shortcut) => can(context, shortcut.needs));
  const coming = COMING.filter((figure) => can(context, figure.needs));
  const firstName = context.actor.name.split(/\s+/)[0];

  return (
    <div className="flex flex-col gap-5">
      <div className="px-1 pt-2">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl" data-testid="greeting">
          {shopGreeting()}, {firstName}
        </h1>
        <p className="mt-1.5 text-muted-foreground">
          {context.business.name} · signed in as {ROLE_LABELS[context.actor.role].toLowerCase()}
          {context.actor.role === "OWNER" ? ", with full admin rights in this business" : ""}
        </p>
      </div>

      {snapshot.adjustmentsWaiting !== null && snapshot.adjustmentsWaiting > 0 && (
        <Link
          href="/stock/adjustments?status=pending"
          data-testid="adjustments-waiting"
          className="flex items-center justify-between gap-3 rounded-3xl bg-accent px-5 py-4 text-sm font-medium text-accent-foreground"
        >
          <span>
            {snapshot.adjustmentsWaiting === 1
              ? "1 stock adjustment is waiting for your approval."
              : `${snapshot.adjustmentsWaiting} stock adjustments are waiting for your approval.`}
          </span>
          <span className="flex items-center gap-1 whitespace-nowrap">
            Review <ArrowUpRight className="size-4" aria-hidden />
          </span>
        </Link>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat testId="stat-products" highlight title="Products" value={snapshot.products.toLocaleString("en-NG")} note="In use and on sale" icon={Boxes} />
        <Stat testId="stat-categories" title="Categories" value={snapshot.categories.toLocaleString("en-NG")} note="Groups of products" icon={Tags} />
        <Stat testId="stat-tax" title="Tax rate" value={`${plainNumber(snapshot.taxRatePercent)}%`} note="Included in prices" icon={Percent} />
        {snapshot.salesToday !== null && (
          <Stat
            testId="stat-sales-today"
            title={snapshot.salesToday.ownOnly ? "Your sales today" : "Sales today"}
            value={nairaFromText(snapshot.salesToday.total)}
            note={`${snapshot.salesToday.count.toLocaleString("en-NG")} sale${snapshot.salesToday.count === 1 ? "" : "s"} since midnight`}
            icon={ChartColumn}
          />
        )}
        {snapshot.collectedToday !== null && (
          <Stat
            testId="stat-collected-today"
            title="Collected today"
            value={nairaFromText(snapshot.collectedToday.total)}
            note={`${nairaFromText(snapshot.collectedToday.cash)} of it in cash`}
            icon={Wallet}
          />
        )}
        {snapshot.staff !== null && (
          <Stat testId="stat-staff" title="Staff" value={snapshot.staff.toLocaleString("en-NG")} note="Active accounts" icon={UserCog} />
        )}
        {snapshot.activityToday !== null && (
          <Stat testId="stat-activity" title="Activity today" value={snapshot.activityToday.toLocaleString("en-NG")} note="Entries in the log since midnight" icon={History} />
        )}
        {coming.map(({ title, icon: Icon }) => (
          <div key={title} className="flex flex-col gap-4 rounded-3xl border border-dashed p-5 text-muted-foreground">
            <div className="flex items-center justify-between">
              <span className="text-sm">{title}</span>
              <Icon className="size-4" aria-hidden />
            </div>
            <div>
              <p className="text-3xl font-semibold tracking-tight opacity-40">—</p>
              <p className="mt-1 text-xs">Coming when selling is built</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-3 xl:grid-cols-5">
        <section className="rounded-3xl bg-card p-6 xl:col-span-2 dark:border dark:border-border">
          <h2 className="text-base font-semibold">Go to</h2>
          <div className="mt-3 flex flex-col gap-2">
            {shortcuts.map(({ href, title, text, icon: Icon }) => (
              <Link key={href} href={href} className="group flex items-center gap-3 rounded-2xl p-3 transition-colors hover:bg-muted">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-semibold">{title}</span>
                  <span className="block text-xs text-muted-foreground">{text}</span>
                </span>
                <ArrowUpRight className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden />
              </Link>
            ))}
          </div>
        </section>

        {snapshot.recentActivity !== null && (
          <section className="rounded-3xl bg-card p-6 xl:col-span-3 dark:border dark:border-border">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Recent activity</h2>
              <Link href="/activity" className="text-sm text-link underline-offset-4 hover:underline">
                See all
              </Link>
            </div>
            {snapshot.recentActivity.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">Nothing has been recorded yet.</p>
            ) : (
              <ul className="mt-3 flex flex-col">
                {snapshot.recentActivity.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-3 border-b py-2.5 last:border-0">
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden />
                    <span className="flex-1 text-sm">{entry.summary}</span>
                    <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">{formatDateTime(entry.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
