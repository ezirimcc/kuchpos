import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { SignOutButton } from "@/components/sign-out-button";
import { Badge } from "@/components/ui/badge";
import { requirePageContext } from "@/server/auth/request";
import { menuFor, type NavItem } from "@/server/navigation";
import { ROLE_LABELS } from "@/server/permissions";
import { closeBusinessAction } from "./owner/businesses/actions";

function MenuList({ title, items }: { title: string; items: NavItem[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="px-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.label}>
            {item.href ? (
              <Link href={item.href} className="block rounded-lg px-3 py-2 text-sm font-medium hover:bg-muted">
                {item.label}
              </Link>
            ) : (
              <span className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-muted-foreground">
                {item.label}
                <span className="text-xs">coming soon</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const context = await requirePageContext();
  const menu = menuFor(context);
  const isOwner = context.actor.role === "OWNER";

  return (
    <div className="flex min-h-screen flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          KuchPos
        </Link>

        <div data-testid="business-banner" className="flex items-center gap-2">
          {context.business ? (
            <>
              <span className="rounded-lg bg-primary px-3 py-1 text-sm font-semibold text-primary-foreground">
                {context.business.name}
              </span>
              {isOwner && (
                <ActionForm action={closeBusinessAction} showSuccess={false}>
                  <SubmitButton variant="outline" size="sm" pendingLabel="Leaving…">
                    Leave this business
                  </SubmitButton>
                </ActionForm>
              )}
            </>
          ) : (
            <span className="rounded-lg border border-dashed px-3 py-1 text-sm text-muted-foreground">
              No business open
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <Link href="/account" className="text-sm underline-offset-4 hover:underline" data-testid="signed-in-as">
            {context.actor.name}
          </Link>
          <Badge variant="secondary" data-testid="role-badge">
            {ROLE_LABELS[context.actor.role]}
          </Badge>
          <Link href="/account" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Change password
          </Link>
          <SignOutButton />
        </div>
      </header>

      <div className="flex flex-1">
        <nav aria-label="Main menu" className="flex w-56 shrink-0 flex-col gap-5 border-r p-3">
          <Link href="/" className="block rounded-lg px-3 py-2 text-sm font-medium hover:bg-muted">
            Home
          </Link>
          <MenuList title={context.business?.name ?? "Business"} items={menu.business} />
          <MenuList title="All businesses" items={menu.owner} />
        </nav>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
