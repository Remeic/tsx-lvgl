import { satisfies, validRange } from "semver";

import { CliError, DIAGNOSTIC_CODES } from "./diagnostics.js";

export const NODE_ENGINE_RANGE = ">=24.19.0 <25";

/**
 * Validate the consumer-declared Node contract with SemVer range semantics.
 * The caller may inject a version to make the diagnostic contract testable.
 */
export function validateNodeEngine(
  packageValue: Readonly<Record<string, unknown>>,
  nodeVersion: string,
  subject: "consumer" | "sdk" = "consumer",
): string {
  const codes = subject === "sdk"
    ? {
      missing: DIAGNOSTIC_CODES.SDK_NODE_ENGINE_MISSING,
      invalid: DIAGNOSTIC_CODES.SDK_NODE_ENGINE_INVALID,
      unsupported: DIAGNOSTIC_CODES.SDK_UNSUPPORTED_NODE,
      label: "installed SDK package",
    }
    : {
      missing: DIAGNOSTIC_CODES.NODE_ENGINE_MISSING,
      invalid: DIAGNOSTIC_CODES.NODE_ENGINE_INVALID,
      unsupported: DIAGNOSTIC_CODES.UNSUPPORTED_NODE,
      label: "package.json",
    };
  const engines = isRecord(packageValue.engines) ? packageValue.engines : undefined;
  const range = engines?.node;
  if (typeof range !== "string" || range.trim().length === 0) {
    throw new CliError(codes.missing, `${codes.label} must declare an engines.node SemVer range`);
  }
  const normalizedRange = validRange(range);
  if (normalizedRange === null) {
    throw new CliError(codes.invalid, `${codes.label} engines.node must be a valid SemVer range`);
  }
  if (!satisfies(nodeVersion, normalizedRange)) {
    throw new CliError(
      codes.unsupported,
      `Node ${nodeVersion} is outside the configured ${subject} engine ${range}`,
    );
  }
  return `Node ${nodeVersion} satisfies ${range}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
