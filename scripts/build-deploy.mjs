/**
 * Builds KuchPos and packs everything the hosting server needs into one zip file:
 *   deploy/kuchpos-deploy.zip
 *
 * Run with:  npm run deploy:build
 *
 * The zip contains no secrets: the .env file lives only on the server.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const out = join(root, "deploy");
const bundle = join(out, "kuchpos");
const zip = join(out, "kuchpos-deploy.zip");

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", cwd: root, ...options });
}

console.log("1/5  Building the app …");
run("npm", ["run", "build"]);

const standalone = join(root, ".next", "standalone");
if (!existsSync(join(standalone, "server.js"))) {
  throw new Error("The build did not produce .next/standalone/server.js.");
}

// The compact build must contain only the app. If project files (source code, documents,
// tests) appear in it, something in the app code made the build copy the whole folder.
const EXPECTED = new Set([".next", "node_modules", "package.json", "server.js", "public", ".env", ".env.example"]);
const unexpected = readdirSync(standalone).filter((name) => !EXPECTED.has(name));
if (unexpected.length > 0) {
  throw new Error(
    `The build contains files that should not be uploaded: ${unexpected.join(", ")}.\n` +
      "This usually means server code reads files from disk using process.cwd(). Remove that and build again.",
  );
}

console.log("2/5  Collecting the files …");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(bundle, "tools"), { recursive: true });

cpSync(standalone, join(bundle, "build"), { recursive: true, verbatimSymlinks: false, dereference: true });
cpSync(join(root, ".next", "static"), join(bundle, "build", ".next", "static"), { recursive: true });
if (existsSync(join(root, "public"))) {
  cpSync(join(root, "public"), join(bundle, "build", "public"), { recursive: true });
}
// The build copies any .env files it finds; the server must only ever use its own.
for (const name of [".env", ".env.local", ".env.production", ".env.example"]) {
  rmSync(join(bundle, "build", name), { force: true });
}

cpSync(join(root, "hosting", "app.js"), join(bundle, "app.js"));
cpSync(join(root, "hosting", "package.json"), join(bundle, "package.json"));
cpSync(join(root, "hosting", "env.example"), join(bundle, "env.example"));
cpSync(join(root, "prisma", "migrations"), join(bundle, "migrations"), { recursive: true });

console.log("3/5  Packing the database tools …");
const esbuild = join(root, "node_modules", ".bin", "esbuild");
const common = ["--bundle", "--platform=node", "--target=node20", "--format=cjs", "--log-level=warning"];
run(esbuild, [join("hosting", "migrate-cli.ts"), ...common, `--outfile=${join(bundle, "tools", "migrate.cjs")}`]);
// The generated database client asks for "import.meta.url", which this file format lacks; supply it.
run(esbuild, [
  join("prisma", "seed.ts"),
  ...common,
  "--define:import.meta.url=__kuchposFileUrl",
  '--banner:js=const __kuchposFileUrl = require("node:url").pathToFileURL(__filename).href;',
  `--outfile=${join(bundle, "tools", "seed.cjs")}`,
]);

const version = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], { cwd: root, encoding: "utf8" }).trim();
writeFileSync(join(bundle, "VERSION.txt"), `${version}\nbuilt ${new Date().toISOString()}\n`);

console.log("4/5  Checking that no secrets are included …");
const localEnv = existsSync(join(root, ".env")) ? readFileSync(join(root, ".env"), "utf8") : "";
const secret = /^BETTER_AUTH_SECRET="?([^"\n]+)"?/m.exec(localEnv)?.[1];
if (secret) {
  let found = "";
  try {
    found = execFileSync("grep", ["-rlF", secret, bundle], { encoding: "utf8" });
  } catch {
    // grep exits with an error when nothing matches, which is what we want.
  }
  if (found.trim()) {
    throw new Error(`This computer's login secret was found inside the build:\n${found}`);
  }
}

console.log("5/5  Creating the zip file …");
run("zip", ["-qr", zip, "."], { cwd: bundle });

const megabytes = (statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`\nReady: deploy/kuchpos-deploy.zip (${megabytes} MB), version ${version}`);
