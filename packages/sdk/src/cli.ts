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
} from "./project.js";

process.exitCode = await runCli(
  process.argv.slice(2),
  process.cwd(),
  { createProject, syncProject, updateProject, checkProject, buildProject, devProject, doctorProject },
  { log: console.log, error: console.error },
);
