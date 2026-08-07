export const DIAGNOSTIC_CODES = {
  ARTIFACT_DIGEST_MISMATCH: "ARTIFACT_DIGEST_MISMATCH",
  ARTIFACT_NOT_FOUND: "ARTIFACT_NOT_FOUND",
  BUNDLE_FAILED: "BUNDLE_FAILED",
  CHECK_FAILED: "CHECK_FAILED",
  CONFIG_INVALID: "CONFIG_INVALID",
  CONFIG_NOT_FOUND: "CONFIG_NOT_FOUND",
  DEV_FAILED: "DEV_FAILED",
  INSTALL_FAILED: "INSTALL_FAILED",
  LOCK_INVALID: "LOCK_INVALID",
  LOCK_NOT_FOUND: "LOCK_NOT_FOUND",
  PACKAGE_INVALID: "PACKAGE_INVALID",
  PACKAGE_NOT_INSTALLED: "PACKAGE_NOT_INSTALLED",
  PROJECT_EXISTS: "PROJECT_EXISTS",
  SOURCE_NOT_CONFIGURED: "SOURCE_NOT_CONFIGURED",
  SOURCE_DIRTY: "SOURCE_DIRTY",
  SOURCE_PACK_FAILED: "SOURCE_PACK_FAILED",
  SDK_NOT_INSTALLED: "SDK_NOT_INSTALLED",
  TYPECHECK_FAILED: "TYPECHECK_FAILED",
  UNSUPPORTED_COMMAND: "UNSUPPORTED_COMMAND",
  UNSUPPORTED_NODE: "UNSUPPORTED_NODE",
  SOURCE_PATH_LEAK: "SOURCE_PATH_LEAK",
} as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

export class CliError extends Error {
  public readonly name = "CliError";

  public constructor(
    public readonly code: DiagnosticCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
    public readonly exitCode = 1,
  ) {
    super(message);
  }
}
export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError("CHECK_FAILED", error instanceof Error ? error.message : String(error));
}
