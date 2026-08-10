import { CliError, type DiagnosticCode, DIAGNOSTIC_CODES } from "./diagnostics.js";

export const DOCTOR_CHECK_IDS = {
  CONFIG: "CONFIG",
  LOCK: "LOCK",
  ARTIFACT: "ARTIFACT",
  PACKAGE: "PACKAGE",
  INSTALLATION: "INSTALLATION",
  PORTABILITY: "PORTABILITY",
  NODE_ENGINE: "NODE_ENGINE",
} as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[keyof typeof DOCTOR_CHECK_IDS];

export const DOCTOR_SUCCESS_CODES = {
  CONFIG_OK: "DOCTOR_CONFIG_OK",
  LOCK_OK: "DOCTOR_LOCK_OK",
  ARTIFACT_OK: "DOCTOR_ARTIFACT_OK",
  PACKAGE_OK: "DOCTOR_PACKAGE_OK",
  INSTALLATION_OK: "DOCTOR_INSTALLATION_OK",
  PORTABILITY_OK: "DOCTOR_PORTABILITY_OK",
  NODE_ENGINE_OK: "DOCTOR_NODE_ENGINE_OK",
} as const;

export type DoctorSuccessCode = (typeof DOCTOR_SUCCESS_CODES)[keyof typeof DOCTOR_SUCCESS_CODES];

export const DOCTOR_RESULT_CODES = {
  OK: "DOCTOR_OK",
  FAILED: "DOCTOR_FAILED",
} as const;

export type DoctorResultCode = (typeof DOCTOR_RESULT_CODES)[keyof typeof DOCTOR_RESULT_CODES];

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly ok: boolean;
  readonly detail: string;
  readonly successCode?: DoctorSuccessCode;
  readonly diagnosticCode?: DiagnosticCode;
}

export interface DoctorResult {
  readonly ok: boolean;
  readonly resultCode: DoctorResultCode;
  readonly checks: readonly DoctorCheck[];
}

export function collectDoctorCheck(
  checks: DoctorCheck[],
  id: DoctorCheckId,
  successCode: DoctorSuccessCode,
  action: () => string,
): void {
  try {
    checks.push({ id, ok: true, detail: action(), successCode });
  } catch (error) {
    const cliError = error instanceof CliError
      ? error
      : new CliError(DIAGNOSTIC_CODES.CHECK_FAILED, String(error));
    checks.push({ id, ok: false, detail: cliError.message, diagnosticCode: cliError.code });
  }
}

export function completeDoctorChecks(checks: readonly DoctorCheck[]): DoctorResult {
  const ok = checks.every((check) => check.ok);
  return {
    ok,
    resultCode: ok ? DOCTOR_RESULT_CODES.OK : DOCTOR_RESULT_CODES.FAILED,
    checks,
  };
}
