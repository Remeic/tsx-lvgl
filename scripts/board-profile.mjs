import { resolve } from "node:path";

const RUNTIME_PROBE = Object.freeze({
  name: "runtime-probe",
  projectPath: "examples/esp-idf/runtime_port_probe",
  artifactPath: "examples/esp-idf/runtime_port_probe/build/tsx_lvgl_runtime_port_probe.bin",
});

const profiles = new Map([[RUNTIME_PROBE.name, RUNTIME_PROBE]]);

/** Single source of truth shared by build and guarded artifact selection. */
export function resolveBoardProfile(name = "runtime-probe", repoRoot = process.cwd()) {
  const profile = profiles.get(name);
  if (profile === undefined) throw new Error(`unsupported board profile: ${name}`);
  return Object.freeze({
    name: profile.name,
    projectDirectory: resolve(repoRoot, profile.projectPath),
    artifact: resolve(repoRoot, profile.artifactPath),
  });
}
