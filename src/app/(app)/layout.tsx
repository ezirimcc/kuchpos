import { Building2, KeyRound, Sprout } from "lucide-react";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { SideNav } from "@/components/side-nav";
import { SignOutButton } from "@/components/sign-out-button";
import { Badge } from "@/components/ui/badge";
import { requirePageContext } from "@/server/auth/request";
import { menuFor } from "@/server/navigation";
import { ROLE_LABELS } from "@/server/permissions";
import { closeBusinessAction } from "./owner/businesses/actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const context = await requirePageContext();
  const menu = menuFor(context);
  const isOwner = context.actor.role === "OWNER";

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
        <Link href="/" className="flex items-center gap-2.5 border-b border-sidebar-border px-5 py-4">
          <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <Sprout className="size-5" aria-hidden />
          </span>
          <span className="text-lg font-semibold tracking-tight text-white">KuchPos</span>
        </Link>
        <SideNav businessTitle={context.business?.name ?? "Business"} business={menu.business} owner={menu.owner} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card/95 px-6 py-3 backdrop-blur">
          <div data-testid="business-banner" className="flex items-center gap-2">
            {context.business ? (
              <>
                <span className="flex items-center gap-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-foreground">
                  <Building2 className="size-4" aria-hidden />
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
              <span className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-1.5 text-sm text-muted-foreground">
                <Building2 className="size-4" aria-hidden />
                No business open
              </span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-3">
            <Link
              href="/account"
              className="text-sm font-medium underline-offset-4 hover:underline"
              data-testid="signed-in-as"
            >
              {context.actor.name}
            </Link>
            <Badge variant="secondary" data-testid="role-badge">
              {ROLE_LABELS[context.actor.role]}
            </Badge>
            <Link
              href="/account"
              className="flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              <KeyRound className="size-3.5" aria-hidden />
              Change password
            </Link>
            <SignOutButton />
          </div>
        </header>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
