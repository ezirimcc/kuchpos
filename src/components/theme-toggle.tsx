"use client";

import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { rememberChoice } from "@/components/app-shell";

/** Switches between the light and the dark look. The choice is remembered in this browser. */
export function ThemeToggle({ startDark }: { startDark: boolean }) {
  const [dark, setDark] = useState(startDark);

  function choose(nextDark: boolean) {
    setDark(nextDark);
    document.documentElement.classList.toggle("dark", nextDark);
    rememberChoice("kuchpos_theme", nextDark ? "dark" : "light");
  }

  const option = "flex size-9 items-center justify-center rounded-full transition-colors";
  return (
    <div
      role="group"
      aria-label="Light or dark mode"
      className="flex items-center gap-0.5 rounded-full bg-card p-1 dark:border dark:border-border"
    >
      <button
        type="button"
        onClick={() => choose(false)}
        aria-pressed={!dark}
        aria-label="Light mode"
        title="Light mode"
        className={cn(option, dark ? "text-muted-foreground hover:text-foreground" : "bg-foreground text-background")}
      >
        <Sun className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => choose(true)}
        aria-pressed={dark}
        aria-label="Dark mode"
        title="Dark mode"
        className={cn(option, dark ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
      >
        <Moon className="size-4" aria-hidden />
      </button>
    </div>
  );
}
