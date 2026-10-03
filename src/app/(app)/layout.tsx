import { Building2 } from "lucide-react";
import { cookies } from "next/headers";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AppShell } from "@/components/app-shell";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { requirePageContext } from "@/server/auth/request";
import { menuFor } from "@/server/navigation";
import { ROLE_LABELS } from "@/server/permissions";
import { closeBusinessAction } from "./owner/businesses/actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const context = await requirePageContext();
  const menu = menuFor(context);
  const isOwner = context.actor.role === "OWNER";
  const choices = await cookies();

  return (
    <AppShell
      startCollapsed={choices.get("kuchpos_sidebar")?.value === "collapsed"}
      businessTitle={context.business?.name ?? "Business"}
      businessMenu={menu.business}
      ownerMenu={menu.owner}
      topLeft={
        <div data-testid="business-banner" className="flex items-center gap-2">
          {context.business ? (
            <>
              <span className="flex h-11 items-center gap-2 rounded-full bg-card px-4 text-sm font-semibold dark:border dark:border-border">
                <Building2 className="size-4 text-link" aria-hidden />
                {context.business.name}
              </span>
              {isOwner && (
                <ActionForm action={closeBusinessAction} showSuccess={false}>
                  <SubmitButton variant="outline" pendingLabel="Leaving…" className="h-11 bg-card">
                    Leave this business
                  </SubmitButton>
                </ActionForm>
              )}
            </>
          ) : (
            <span className="flex h-11 items-center gap-2 rounded-full border border-dashed px-4 text-sm text-muted-foreground">
              <Building2 className="size-4" aria-hidden />
              No business open
            </span>
          )}
        </div>
      }
      topRight={
        <>
          <ThemeToggle startDark={choices.get("kuchpos_theme")?.value === "dark"} />
          <UserMenu name={context.actor.name} username={context.actor.username} roleLabel={ROLE_LABELS[context.actor.role]} />
        </>
      }
    >
      {children}
    </AppShell>
  );
}
