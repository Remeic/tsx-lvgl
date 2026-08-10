import { CliError, type DiagnosticCode, DIAGNOSTIC_CODES } from "./diagnostics.js";

export const DOCTOR_CHECK_IDS = {
  CONFIG: "CONFIG",
  LOCK: "LOCK",
  ARTIFACT: "ARTIFACT",
  PACKAGE: "PACKAGE",
  INSTALLATION: "INSTALLATION",
  PORTABILITY: "PORTABILITY",
  CONSUMER_NODE_ENGINE: "CONSUMER_NODE_ENGINE",
  SDK_NODE_ENGINE: "SDK_NODE_ENGINE",
} as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[keyof typeof DOCTOR_CHECK_IDS];

export const DOCTOR_SUCCESS_CODES = {
  CONFIG_OK: "DOCTOR_CONFIG_OK",
  LOCK_OK: "DOCTOR_LOCK_OK",
  ARTIFACT_OK: "DOCTOR_ARTIFACT_OK",
  PACKAGE_OK: "DOCTOR_PACKAGE_OK",
  INSTALLATION_OK: "DOCTOR_INSTALLATION_OK",
  PORTABILITY_OK: "DOCTOR_PORTABILITY_OK",
  CONSUMER_NODE_ENGINE_OK: "DOCTOR_CONSUMER_NODE_ENGINE_OK",
  SDK_NODE_ENGINE_OK: "DOCTOR_SDK_NODE_ENGINE_OK",
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

export interface DoctorInspection {
  config(): string;
  lock(): string;
  artifact(): string;
  package(): string;
  installation(): string;
  portability(): string;
  consumerNodeEngine(): string;
  sdkNodeEngine(): string;
}

/** Stable doctor orchestration; project storage details stay behind callbacks. */
export function runDoctor(inspection: DoctorInspection): DoctorResult {
  const checks: DoctorCheck[] = [];
  collectDoctorCheck(checks, DOCTOR_CHECK_IDS.CONFIG, DOCTOR_SUCCESS_CODES.CONFIG_OK, inspection.config);
  collectDoctorCheck(checks, DOCTOR_CHECK_IDS.LOCK, DOCTOR_SUCCESS_CODES.LOCK_OK, inspection.lock);
  collectDoctorCheck(checks, DOCTOR_CHECK_IDS.ARTIFACT, DOCTOR_SUCCESS_CODES.ARTIFACT_OK, inspection.artifact);
  collectDoctorCheck(checks, DOCTOR_CHECK_IDS.PACKAGE, DOCTOR_SUCCESS_CODES.PACKAGE_OK, inspection.package);
  collectDoctorCheck(checks, DOCTOR_CHECK_IDS.INSTALLATION, DOCTOR_SUCCESS_CODES.INSTALLATION_OK, inspection.installation);
  collectDoctorCheck(checks, DOCTOR_CHECK_IDS.PORTABILITY, DOCTOR_SUCCESS_CODES.PORTABILITY_OK, inspection.portability);
  collectDoctorCheck(
    checks,
    DOCTOR_CHECK_IDS.CONSUMER_NODE_ENGINE,
    DOCTOR_SUCCESS_CODES.CONSUMER_NODE_ENGINE_OK,
    inspection.consumerNodeEngine,
  );
  collectDoctorCheck(
    checks,
    DOCTOR_CHECK_IDS.SDK_NODE_ENGINE,
    DOCTOR_SUCCESS_CODES.SDK_NODE_ENGINE_OK,
    inspection.sdkNodeEngine,
  );
  return completeDoctorChecks(checks);
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
