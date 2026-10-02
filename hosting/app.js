/**
 * Start-up file for the hosting server (HOSTAFRICA "Setup Node.js App").
 * The server runs this file; it loads the settings from the .env file next to
 * it and then starts the KuchPos build in the "build" folder.
 */
const fs = require("node:fs");
const path = require("node:path");

const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
process.env.NODE_ENV = "production";

try {
  process.env.KUCHPOS_VERSION = fs.readFileSync(path.join(__dirname, "VERSION.txt"), "utf8").split("\n")[0].trim();
} catch {
  process.env.KUCHPOS_VERSION = "unknown";
}

for (const name of ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]) {
  if (!process.env[name]) {
    console.error(`KuchPos cannot start: the setting ${name} is missing from the .env file.`);
  }
}

require("./build/server.js");
