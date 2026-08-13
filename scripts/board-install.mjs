import { spawnSync } from "node:child_process";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultProfile = "runtime-probe";
const defaultEntry = "examples/apps/pomodoro.tsx";

function usage() {
  return `Usage:
  npm run board:install -- [options] [--execute]

Options:
  --entry PATH        TSX entry to embed; defaults to ${defaultEntry}.
  --app NAME          Shorthand for examples/apps/NAME.tsx.
  --bundle-id ID      Bundle identity; defaults to the entry basename.
  --profile NAME      Board profile; default ${defaultProfile}.
  --port PATH         Board serial path.
  --recovery-dir PATH External same-board recovery directory.
  --esptool-python PATH
                      Python executable with esptool/espefuse 5.3.1.
  --reset-mode MODE   watchdog-reset (default) or hard-reset.
  --execute           Run the guarded app-only firmware install.
  --dry-run           Build and print the guarded plan without hardware (default).
  --help              Show this help.

The command embeds generation 1, rebuilds the runtime probe, and delegates
physical writes to board:reload. --execute is required for hardware access.
`;
}

function defaultBundleId(entry) {
  return basename(entry, extname(entry)).toLowerCase();
}

export function parseCli(argv, env = process.env) {
  const options = {
    entry: defaultEntry,
    bundleId: "",
    profile: defaultProfile,
    port: env.TSX_LVGL_BOARD_PORT ?? "",
    recoveryDir: env.TSX_LVGL_RECOVERY_DIR ?? "",
    esptoolPython: env.ESPTOOL_PYTHON ?? "",
    resetMode: "watchdog-reset",
    execute: false,
    dryRun: true,
  };
  let entrySpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--execute") {
      options.execute = true;
      options.dryRun = false;
      continue;
    }
    if (argument === "--dry-run") {
      options.execute = false;
      options.dryRun = true;
      continue;
    }

    const [name, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (inlineValue === undefined) index += 1;

    switch (name) {
      case "--entry":
        if (entrySpecified) throw new Error("--entry and --app are mutually exclusive");
        options.entry = value;
        entrySpecified = true;
        break;
      case "--app":
        if (entrySpecified) throw new Error("--entry and --app are mutually exclusive");
        if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("--app must be a simple app name");
        options.entry = `examples/apps/${value}.tsx`;
        entrySpecified = true;
        break;
      case "--bundle-id":
        options.bundleId = value;
        break;
      case "--profile":
        options.profile = value;
        break;
      case "--port":
        options.port = value;
        break;
      case "--recovery-dir":
        options.recoveryDir = value;
        break;
      case "--esptool-python":
        options.esptoolPython = value;
        break;
      case "--reset-mode":
        options.resetMode = value;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }

  if (!options.bundleId) options.bundleId = defaultBundleId(options.entry);
  return { help: false, options };
}

function appendFlag(args, name, value) {
  if (value) args.push(name, value);
}

export function buildCommandPlan(options) {
  const embedArgs = ["scripts/embed-runtime-app.mjs", "--entry", options.entry, "--profile", options.profile, "--bundle-id", options.bundleId];
  const reloadArgs = ["run", "board:reload", "--", "--profile", options.profile, "--reset-mode", options.resetMode];
  appendFlag(reloadArgs, "--port", options.port);
  appendFlag(reloadArgs, "--recovery-dir", options.recoveryDir);
  appendFlag(reloadArgs, "--esptool-python", options.esptoolPython);
  reloadArgs.push(options.execute ? "--execute" : "--dry-run");

  return [
    { command: ["npm", "run", "build"], env: {} },
    { command: ["node", ...embedArgs], env: {} },
    { command: ["node", "scripts/build-kernel.mjs"], env: {} },
    { command: ["npm", "run", "board:build"], env: {} },
    {
      command: ["npm", ...reloadArgs],
      env: options.execute ? { TSX_LVGL_SKIP_BUILD: "1" } : {},
    },
  ];
}

export function runCommandPlan(plan, root = repoRoot, runner = spawnSync) {
  for (const step of plan) {
    const result = runner(step.command[0], step.command.slice(1), {
      cwd: root,
      env: { ...process.env, ...step.env },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) return result.status ?? 1;
  }
  return 0;
}

async function run() {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error(`board-install: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (parsed.help) {
    console.log(usage());
    return;
  }

  try {
    process.exitCode = runCommandPlan(buildCommandPlan(parsed.options));
  } catch (error) {
    console.error(`board-install: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) await run();

export { defaultEntry, defaultProfile, usage };
