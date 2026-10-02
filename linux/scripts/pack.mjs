// Copies the installers Tauri buries in target/release/bundle/ into release/,
// under the names they ship with. Used by `npm run pack` and the Linux release
// workflow, so both produce exactly the same file names.
//
//   Linux -> .deb and .AppImage

import { readFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(root, "target", "release", "bundle");
const outDir = join(root, "release");

const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

/** Newest file in `dir` ending with `suffix`, or null. Newest wins so a stale
 *  build lying around cannot be picked over the one we just made. */
function newest(dir, suffix) {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(suffix));
    if (files.length === 0) return null;
    return files
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return null;
  }
}

/** [source, shipping name] pairs. */
const jobs = [];
const deb = newest(join(bundleDir, "deb"), ".deb");
if (deb) {
  jobs.push([deb, `Coucou-${version}-amd64.deb`], [deb, "Coucou-latest-amd64.deb"]);
}
const appimage = newest(join(bundleDir, "appimage"), ".AppImage");
if (appimage) {
  jobs.push(
    [appimage, `Coucou-${version}-x86_64.AppImage`],
    [appimage, "Coucou-latest-x86_64.AppImage"],
  );
}

if (jobs.length === 0) {
  console.error(`No installer found under ${bundleDir} — run \`npm run tauri build\` first.`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
console.log();
for (const [src, name] of jobs) {
  const dest = join(outDir, name);
  copyFileSync(src, dest);
  const mb = (statSync(dest).size / 1024 / 1024).toFixed(2);
  console.log(`  ${mb.padStart(6)} MB  ${dest}`);
}
console.log();
