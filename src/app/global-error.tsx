"use client";

/**
 * The last resort: shown when even the frame of the app could not be drawn. It brings its
 * own page and plain styles, because nothing of the app's own can be relied on here.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "3rem 1.5rem", maxWidth: "36rem", margin: "0 auto", lineHeight: 1.5 }}>
        <h1 style={{ fontSize: "1.25rem" }}>KuchPos could not open</h1>
        <p>
          Something went wrong on our side. Nothing has been lost. Try again in a moment; if it keeps happening, tell the owner
          {error.digest ? ` and give this code: ${error.digest}` : ""}.
        </p>
        <p>
          <button type="button" onClick={() => retry()} style={{ padding: "0.5rem 1rem", borderRadius: "999px", border: "1px solid #999", background: "white", cursor: "pointer" }}>
            Try again
          </button>
        </p>
      </body>
    </html>
  );
}
