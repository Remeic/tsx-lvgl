import { readFileSync } from "node:fs";

const messagePath = process.argv[2];
if (!messagePath) {
  console.error("commit-msg: missing commit message path");
  process.exit(1);
}

const message = readFileSync(messagePath, "utf8");
const header = message.split(/\r?\n/u).find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? "";
const allowedTypes = "feat|fix|docs|test|refactor|build|ci|chore|perf|revert";
const allowedScopes = "core|compiler|emitter|runtime|board|simulator|docs|ci|deps|tooling|repo|release";
const headerPattern = new RegExp(`^(${allowedTypes})\\((${allowedScopes})\\): ([a-z0-9][^\\n.]*)$`, "u");

const errors = [];
if (header.length > 72) errors.push("header must be at most 72 characters");
if (!headerPattern.test(header)) {
  errors.push(`header must match <type>(<scope>): <lowercase subject>; allowed types: ${allowedTypes.replaceAll("|", ", ")}; allowed scopes: ${allowedScopes.replaceAll("|", ", ")}`);
}

if (header.startsWith("feat(") && !/\b(?:Refs|Closes|Fixes)\s+#\d+\b/u.test(message)) {
  errors.push("feat commits must reference a GitHub issue with Refs #N, Closes #N or Fixes #N");
}

if (errors.length > 0) {
  console.error("Invalid commit message:\n");
  for (const error of errors) console.error(`- ${error}`);
  console.error("\nExample: feat(compiler): emit deterministic LVGL C\n         Refs #12");
  process.exit(1);
}
