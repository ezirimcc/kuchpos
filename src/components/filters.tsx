"use client";

import { LoaderCircle, Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * Filter controls for list screens. Each one writes its value into the page
 * address (?q=…&category=…) and the list underneath is refreshed in place,
 * without the whole page reloading. Changing a filter always returns to page 1.
 */
/**
 * The filters most recently asked for on a screen, which may be ahead of what the address
 * bar shows while the list is still refreshing. Each control builds on this, so changing
 * two filters in quick succession (typing, then picking a category) never loses one of them.
 */
let requested: { pathname: string; query: string } | null = null;

function useListParam(name: string) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const current = params.get(name) ?? "";
  const shown = params.toString();

  useEffect(() => {
    // The address has caught up with (or moved on from) what was asked for.
    if (requested && (requested.pathname !== pathname || requested.query === shown)) requested = null;
  }, [pathname, shown]);

  function set(value: string) {
    // Start from the filters most recently asked for, or else from what the address bar holds
    // right now. Never from a remembered copy: a delayed search could otherwise undo a filter
    // that was chosen while it was waiting.
    const base =
      requested && requested.pathname === pathname ? requested.query : window.location.search.replace(/^\?/, "");
    const next = new URLSearchParams(base);
    if (value) next.set(name, value);
    else next.delete(name);
    next.delete("page");
    const query = next.toString();
    if (query === base) return;
    requested = { pathname, query };
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  }

  return { current, set, pending };
}

/** A search box that filters the list as you type (after a short pause between keystrokes). */
export function LiveSearch({
  name = "q",
  label,
  placeholder,
  autoFocus = false,
}: {
  name?: string;
  label: string;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const { current, set, pending } = useListParam(name);
  // The box keeps its own text (it is not driven by React), so nothing typed is ever
  // overwritten — not even letters typed in the instant before the page finishes loading.
  const input = useRef<HTMLInputElement>(null);
  const [hasText, setHasText] = useState(current !== "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef(current);

  function search(value: string, delay: number) {
    setHasText(value !== "");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastSent.current = value.trim();
      set(value.trim());
    }, delay);
  }

  // Letters typed before the page was ready never reached React: pick them up now.
  useEffect(() => {
    const typed = input.current?.value ?? "";
    if (typed.trim() !== lastSent.current) search(typed, 0);
    return () => void (timer.current && clearTimeout(timer.current));
    // Runs once, when the box first becomes interactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the box in step when the address changes some other way (Back button, "Clear filters").
  useEffect(() => {
    if (current !== lastSent.current) {
      lastSent.current = current;
      if (input.current) input.current.value = current;
      setHasText(current !== "");
    }
  }, [current]);

  function clear() {
    if (input.current) {
      input.current.value = "";
      input.current.focus();
    }
    search("", 0);
  }

  return (
    <div className="relative w-80 max-w-full">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        ref={input}
        type="search"
        defaultValue={current}
        onChange={(event) => search(event.target.value, 250)}
        placeholder={placeholder}
        aria-label={label}
        autoFocus={autoFocus}
        autoComplete="off"
        className="pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
      />
      <span className="absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground">
        {pending ? (
          <LoaderCircle className="size-4 animate-spin" aria-label="Searching" />
        ) : hasText ? (
          <button type="button" onClick={clear} aria-label="Clear search" className="flex rounded hover:text-foreground">
            <X className="size-4" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** A drop-down that filters the list as soon as a choice is made. */
export function FilterSelect({
  name,
  label,
  options,
  allLabel,
}: {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  allLabel: string;
}) {
  const { current, set } = useListParam(name);
  return (
    <NativeSelect value={current} onChange={(event) => set(event.target.value)} aria-label={label} className="w-56">
      <option value="">{allLabel}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </NativeSelect>
  );
}

/** A date box that filters the list as soon as a date is chosen. */
export function FilterDate({ name, label }: { name: string; label: string }) {
  const { current, set } = useListParam(name);
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      {label}
      <Input
        type="date"
        value={current}
        onChange={(event) => set(event.target.value)}
        aria-label={label}
        className="w-40 text-foreground"
      />
    </label>
  );
}

/** A tick-box that filters the list as soon as it is changed. */
export function FilterToggle({ name, label }: { name: string; label: string }) {
  const { current, set } = useListParam(name);
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={current === "1"}
        onChange={(event) => set(event.target.checked ? "1" : "")}
        className="size-4 accent-primary"
      />
      {label}
    </label>
  );
}
