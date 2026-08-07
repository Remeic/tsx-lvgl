export interface KernelModule {
  readonly specifier: string;
  /** CJS-transpiled module body. */
  readonly code: string;
}

export function wrapCjsModule(module: KernelModule): string {
  return `__tsxDefine(${JSON.stringify(module.specifier)}, function (require, module, exports) {\n${module.code}\n});`;
}

/**
 * Tiny self-contained JS prelude defining `__tsxDefine`/`__tsxRequire`, the
 * CommonJS-shaped loader every kernel module (`wrapCjsModule` output) plugs
 * into. Deterministic: no timestamps, no environment-dependent values.
 */
export function renderKernelLoader(): string {
  return `"use strict";
var __tsxModules = {};
var __tsxCache = {};
function __tsxDefine(name, factory) {
  __tsxModules[name] = factory;
}
function __tsxRequire(name) {
  if (Object.prototype.hasOwnProperty.call(__tsxCache, name)) {
    return __tsxCache[name].exports;
  }
  if (!Object.prototype.hasOwnProperty.call(__tsxModules, name)) {
    throw new Error("unknown module: " + name);
  }
  var module = { exports: {} };
  __tsxCache[name] = module;
  __tsxModules[name](__tsxRequire, module, module.exports);
  return module.exports;
}
`;
}
