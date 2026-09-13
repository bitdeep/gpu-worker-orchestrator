import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, copyFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const files = ["package.json", "LICENSE", "README.md", "THIRD_PARTY.md"];
async function walk(directory) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await walk(name);
    else if (entry.isFile() && /\.(js|d\.ts)$/.test(name) && !name.includes(".test.")) files.push(name);
    else throw new Error(`Unexpected build entry: ${name}`);
  }
}
await walk("dist");
if (!files.includes("dist/index.js")) throw new Error("Build the SDK before creating a release");
const hashes = {};
for (const name of files.sort()) {
  hashes[name] = createHash("sha256").update(await readFile(join(root, name))).digest("hex");
}
const manifest = JSON.stringify({ name: pkg.name, version: pkg.version, files: hashes }, null, 2) + "\n";
const digest = createHash("sha256").update(manifest).digest("hex");
const target = join(root, "artifacts", `inference-sdk-${pkg.version}-${digest.slice(0, 12)}`);
await mkdir(target, { recursive: true });
for (const name of files) {
  await mkdir(dirname(join(target, name)), { recursive: true });
  await copyFile(join(root, name), join(target, name));
}
await writeFile(join(target, "MANIFEST.json"), manifest);
console.log(JSON.stringify({ artifact: target.slice(root.length + 1), sha256: digest, files: files.length }));
