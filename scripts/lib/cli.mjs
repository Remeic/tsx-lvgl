/**
 * Shared `--flag=value` / `--flag value` parsing for the CLI scripts under
 * scripts/. Not published; only imported by scripts/*.mjs.
 */

/**
 * Resolves the value for the flag at `argv[index]`, accepting either the
 * `--flag=value` inline form or a separate `--flag value` slot. Returns the
 * flag name (without any inline value), the resolved value, and the index
 * the caller's loop should continue from (unchanged for the inline form,
 * `index + 1` when the next argv slot was consumed). Throws
 * `Error("<name> requires a value")` when the value is missing or itself
 * looks like a flag.
 */
export function readFlagValue(argv, index) {
  const argument = argv[index];
  const [name, inlineValue] = argument.split("=", 2);
  const value = inlineValue ?? argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  const nextIndex = inlineValue !== undefined ? index : index + 1;
  return { name, value, nextIndex };
}
