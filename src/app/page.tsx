import { connection } from "next/server";
import { checkDatabase } from "@/lib/db";

export default async function Home() {
  // Check the database on every visit rather than once when the app is built.
  await connection();
  const database = await checkDatabase();

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">KuchPos</h1>
      <p className="max-w-md text-muted-foreground">
        Point of sale and inventory. The app is set up and ready for the next milestone.
      </p>
      {database.connected ? (
        <p
          data-testid="database-status"
          className="rounded-md border border-green-600/30 bg-green-600/10 px-4 py-2 text-green-800 dark:text-green-300"
        >
          Database connected (PostgreSQL {database.serverVersion})
        </p>
      ) : (
        <p
          data-testid="database-status"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-2 text-destructive"
        >
          Database not connected. {database.reason} Check that Postgres is running and that
          the .env file is filled in.
        </p>
      )}
    </main>
  );
}
