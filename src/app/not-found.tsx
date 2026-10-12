import Link from "next/link";

/** Shown for an address that leads nowhere (a mistyped link, or a record that no longer exists). */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-full max-w-xl flex-col items-start justify-center gap-4 p-8">
      <h1 className="text-xl font-semibold">That page could not be found</h1>
      <p className="text-sm text-muted-foreground">The address may be mistyped, or the record may have been deleted or belong to another business.</p>
      <Link href="/" className="text-link underline-offset-4 hover:underline">
        Go to the home page
      </Link>
    </main>
  );
}
