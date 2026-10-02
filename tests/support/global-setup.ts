import { execFileSync } from "node:child_process";
import { config as loadEnv } from "dotenv";

/** Runs once before the database tests: brings the TEST database structure up to date. */
export default function setup() {
  loadEnv({ quiet: true });
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is not set. See .env.example.");
  }
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `Refusing to run tests against "${databaseName}": the test database name must end in "_test".`,
    );
  }
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
