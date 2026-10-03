import { History, type LucideIcon, Package, Settings, UserCog } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requirePageContext } from "@/server/auth/request";
import { can, type Permission, ROLE_LABELS } from "@/server/permissions";

const SHORTCUTS: { href: string; title: string; text: string; icon: LucideIcon; needs: Permission }[] = [
  { href: "/products", title: "Products & prices", text: "Look up a price, or add and change products.", icon: Package, needs: "price.view" },
  { href: "/staff", title: "Staff", text: "Add people and set what they can do.", icon: UserCog, needs: "staff.manage" },
  { href: "/activity", title: "Activity log", text: "See who did what, and when.", icon: History, needs: "activityLog.view" },
  { href: "/settings", title: "Settings", text: "Tax rate, receipts, terminals and sign-out time.", icon: Settings, needs: "settings.manage" },
];

export default async function HomePage() {
  const context = await requirePageContext();
  // An owner with no business open starts at the list of businesses.
  if (!context.business) redirect("/owner/businesses");

  const shortcuts = SHORTCUTS.filter((shortcut) => can(context, shortcut.needs));

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader
        title={`Welcome, ${context.actor.name}`}
        description={
          <>
            {context.business.name} · signed in as {ROLE_LABELS[context.actor.role].toLowerCase()}
            {context.actor.role === "OWNER" ? ", with full admin rights in this business" : ""}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {shortcuts.map(({ href, title, text, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex items-start gap-4 rounded-xl border bg-card p-5 shadow-xs transition-colors hover:border-primary/40 hover:bg-accent/40"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
              <Icon className="size-5" aria-hidden />
            </span>
            <span>
              <span className="block font-semibold group-hover:text-primary">{title}</span>
              <span className="block text-sm text-muted-foreground">{text}</span>
            </span>
          </Link>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        Menu items marked “coming soon” are part of your role and will be switched on as each part of KuchPos is built.
      </p>
    </div>
  );
}
