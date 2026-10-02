import { execFileSync } from "node:child_process";

/** Browser tests start from fresh sample data. This WIPES the development database's sample data. */
export default function globalSetup() {
  execFileSync("npm", ["run", "db:seed"], { stdio: "pipe" });
}
