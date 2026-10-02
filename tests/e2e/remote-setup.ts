/**
 * Before running the browser tests against the online TEST site: wait until the
 * server answers. Just after a restart its first replies can take a long time,
 * which would otherwise look like test failures.
 */
export default async function remoteSetup() {
  const base = process.env.E2E_BASE_URL;
  if (!base) return;
  const deadline = Date.now() + 120_000;
  let lastProblem = "no reply";

  while (Date.now() < deadline) {
    try {
      const health = await fetch(new URL("/api/health", base), { signal: AbortSignal.timeout(30_000) });
      const page = await fetch(new URL("/sign-in", base), { signal: AbortSignal.timeout(30_000) });
      if (health.ok && page.ok) return;
      lastProblem = `health ${health.status}, sign-in page ${page.status}`;
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`The online site at ${base} did not become ready within two minutes (${lastProblem}).`);
}
