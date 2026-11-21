// Packages the screens into the program: a production build of Volar-admin as a
// self-contained server (Next.js "standalone"), copied to ./ui with its static files.
//
//   npm run build:ui      (ADMIN_DIR=../Volar-admin by default)
//
// The admin builds into its own folder (.next-desktop), so this never touches its web build (.next).
// Inside the program the admin runs in desktop mode: it finds the bridge (preload.js) and sends
// every API call through it, so the API's address baked into the build doesn't matter.
import { execSync } from "node:child_process";
import { cpSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const here = resolve(import.meta.dirname, "..");
const admin = resolve(here, process.env.ADMIN_DIR ?? "../Volar-admin");
const dist = ".next-desktop";
const out = join(here, "ui");

console.log(`building the screens from ${admin}…`);
execSync("npx next build", {
  cwd: admin,
  stdio: "inherit",
  env: { ...process.env, NEXT_OUTPUT: "standalone", NEXT_DIST_DIR: dist, NEXT_TELEMETRY_DISABLED: "1" },
});

const standalone = join(admin, dist, "standalone");
if (!existsSync(join(standalone, "server.js"))) throw new Error(`no server.js in ${standalone}`);
rmSync(out, { recursive: true, force: true });
// on Windows the standalone output may link packages (junctions to absolute paths): copy what they point at
cpSync(standalone, out, { recursive: true, dereference: true });
// what the standalone server doesn't copy by itself: the static files, and public/ when the admin has one
cpSync(join(admin, dist, "static"), join(out, dist, "static"), { recursive: true });
if (existsSync(join(admin, "public"))) cpSync(join(admin, "public"), join(out, "public"), { recursive: true });
// no local secrets in the program
for (const f of [".env", ".env.local", ".env.development", ".env.production", ".env.example"]) rmSync(join(out, f), { force: true });
// the installer leaves out every folder called node_modules: the server's go in deps/,
// and start.js tells Node to look there
renameSync(join(out, "node_modules"), join(out, "deps"));
writeFileSync(
  join(out, "start.js"),
  `const path = require("path");
process.env.NODE_PATH = [path.join(__dirname, "deps"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require("module").Module._initPaths();
require("./server.js");
`,
);
console.log(`screens ready in ${out}`);
