import { resolve } from "node:path";

const profiles = new Map([["runtime-probe", Object.freeze({ name: "runtime-probe", projectPath: "examples/esp-idf/runtime_port_probe", artifactPath: "examples/esp-idf/runtime_port_probe/build/tsx_lvgl_runtime_port_probe.bin", boardId: "waveshare.esp32s3.touch-amoled-1.8" })]]);

/** Single source of truth for the build directory, artifact, and board identity. */
export function resolveBoardProfile(name = "runtime-probe", repoRoot = process.cwd()) {
  const profile = profiles.get(name);
  if (profile === undefined) throw new Error(`unsupported board profile: ${name}`);
  return Object.freeze({ ...profile, projectDirectory: resolve(repoRoot, profile.projectPath), artifact: resolve(repoRoot, profile.artifactPath) });
}
