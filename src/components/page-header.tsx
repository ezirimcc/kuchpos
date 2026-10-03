import type { LucideIcon } from "lucide-react";

/** The title block at the top of every screen: icon, title, one line of explanation, and optional buttons. */
export function PageHeader({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-1 pt-1">
      <div className="flex items-start gap-3">
        {Icon && (
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-card text-link dark:border dark:border-border">
            <Icon className="size-5" aria-hidden />
          </span>
        )}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
