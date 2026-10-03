"use client";

import { PanelLeftClose, PanelLeftOpen, Sprout } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cn } from "cn";
import { SideNav, type SideNavItem } from "@/components/side-nav";

/** Remembers a small display choice (menu width, light/dark) in this browser for a year. */
export function rememberChoice(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

/**
 * The frame around every signed-in screen: the side menu (which collapses to icons only)
 * and the top bar. The menu's width is remembered in this browser.
 */
export function AppShell({
  startCollapsed,
  businessTitle,
  businessMenu,
  ownerMenu,
  topLeft,
  topRight,
  children,
}: {
  startCollapsed: boolean;
  businessTitle: string;
  businessMenu: SideNavItem[];
  ownerMenu: SideNavItem[];
  topLeft: React.ReactNode;
  topRight: React.ReactNode;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(startCollapsed);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    rememberChoice("kuchpos_sidebar", next ? "collapsed" : "expanded");
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 p-3">
      <aside
        data-testid="side-menu"
        data-collapsed={collapsed}
        className={cn(
          "sticky top-3 flex h-[calc(100vh-1.5rem)] shrink-0 flex-col rounded-3xl bg-sidebar text-sidebar-foreground transition-[width] duration-200 dark:border dark:border-sidebar-border",
          collapsed ? "w-[76px]" : "w-64",
        )}
      >
        <Link
          href="/"
          className={cn("flex items-center gap-2.5 px-5 pt-5 pb-3", collapsed && "justify-center px-0")}
          title="KuchPos home"
        >
          <span className="bg-brand-gradient flex size-9 shrink-0 items-center justify-center rounded-xl text-white shadow-sm">
            <Sprout className="size-5" aria-hidden />
          </span>
          <span className={collapsed ? "sr-only" : "text-lg font-semibold tracking-tight text-foreground"}>KuchPos</span>
        </Link>
        <SideNav businessTitle={businessTitle} business={businessMenu} owner={ownerMenu} collapsed={collapsed} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <header className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand the menu" : "Collapse the menu"}
            aria-pressed={collapsed}
            title={collapsed ? "Expand the menu" : "Collapse the menu"}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-card text-muted-foreground transition-colors hover:text-foreground dark:border dark:border-border"
          >
            {collapsed ? <PanelLeftOpen className="size-5" aria-hidden /> : <PanelLeftClose className="size-5" aria-hidden />}
          </button>
          {topLeft}
          <div className="ml-auto flex items-center gap-3">{topRight}</div>
        </header>
        <main className="flex-1 pb-3">{children}</main>
      </div>
    </div>
  );
}
