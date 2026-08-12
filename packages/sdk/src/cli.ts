#!/usr/bin/env node

import { runCli } from "./cli-runtime.js";
import {
  buildProject,
  checkProject,
  createProject,
  devProject,
  doctorProject,
  syncProject,
  updateProject,
  watchDeviceProject,
} from "./project.js";

const controller = new AbortController();
const stop = (): void => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    process.cwd(),
    { createProject, syncProject, updateProject, checkProject, buildProject, devProject, watchDeviceProject, doctorProject },
    { log: console.log, error: console.error },
    { signal: controller.signal },
  );
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
