import { connection } from "next/server";

/**
 * A bright strip across the top of every page on the online TEST site, so nobody
 * mistakes sample data for the real thing. Shown when the server setting
 * KUCHPOS_ENVIRONMENT is "test". Read on each request, so it follows the server it runs on.
 */
export async function EnvironmentBanner() {
  await connection();
  if (process.env.KUCHPOS_ENVIRONMENT !== "test") return null;
  return (
    <div
      data-testid="environment-banner"
      className="bg-amber-400 px-4 py-1.5 text-center text-sm font-semibold text-black"
    >
      TEST — sample data. Nothing entered here is real.
    </div>
  );
}
