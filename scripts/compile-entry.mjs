#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileProject } from "../packages/compiler/dist/index.js";

const [entryArgument, outputArgument, projectArgument] = process.argv.slice(2);
if (entryArgument === undefined || outputArgument === undefined) {
  console.error("usage: node scripts/compile-entry.mjs <entry.tsx> <output-directory> [project-name]");
  process.exit(2);
}

const entryFile = resolve(entryArgument);
const outputDirectory = resolve(outputArgument);
const artifacts = compileProject({
  entryFile,
  ...(projectArgument === undefined ? {} : { projectName: projectArgument }),
});
await mkdir(outputDirectory, { recursive: true });
for (const [relativePath, content] of Object.entries(artifacts.files)) {
  const destination = resolve(outputDirectory, relativePath.replace(/^generated\//, ""));
  await mkdir(resolve(destination, ".."), { recursive: true });
  await writeFile(destination, content, "utf8");
}
console.log(`compiled ${entryFile} -> ${outputDirectory}`);
