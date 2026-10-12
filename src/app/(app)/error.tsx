"use client";

import { Button } from "@/components/ui/button";

/**
 * Shown in place of a screen that could not be drawn. The technical details were written to
 * the app's error log on the server; the person is only told what to do next.
 */
export default function ScreenError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-start gap-4 rounded-3xl bg-card p-8" role="alert">
      <h1 className="text-xl font-semibold">This screen could not be opened</h1>
      <p className="text-sm text-muted-foreground">
        Something went wrong on our side. Nothing you entered elsewhere has been lost or changed. Try again; if it keeps happening, tell the
        owner what you were doing{error.digest ? ` and give this code: ${error.digest}` : ""}.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => retry()}>
          Try again
        </Button>
        {/* A full page load on purpose: after a failure, start again from a clean slate. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className="inline-flex h-9 items-center rounded-full border px-4 text-sm font-medium">
          Go to the home page
        </a>
      </div>
    </div>
  );
}
