import type { DeviceDevResult, DevicePushBundle } from "./device-dev.js";

export interface DeviceWatchHandle {
  close(): void;
}

export interface DeviceWatchOptions {
  readonly initialGeneration: number;
  /** Settling window for duplicate filesystem notifications. Defaults to 75ms. */
  readonly debounceMs?: number;
  readonly signal: AbortSignal;
  readonly watch: (
    onChange: () => void,
    onError: (error: Error) => void,
  ) => DeviceWatchHandle;
  readonly build: (generation: number) => DevicePushBundle | Promise<DevicePushBundle>;
  readonly push: (bundle: DevicePushBundle) => Promise<DeviceDevResult>;
  readonly onAccepted: (result: DeviceDevResult) => void;
  readonly onRejected: (error: Error) => void;
}

/**
 * Runs one build immediately, then coalesces source changes behind at most one
 * build/push. Failed builds leave the last accepted device application intact
 * and do not terminate the development session.
 */
export async function runDeviceWatch(options: DeviceWatchOptions): Promise<void> {
  let generation = options.initialGeneration;
  let acceptedSha256: string | undefined;
  let pending = true;
  let wake: (() => void) | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const notify = (): void => {
    pending = true;
    wake?.();
    wake = undefined;
  };
  const requestBuild = (): void => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      notify();
    }, options.debounceMs ?? 75);
  };
  const reportRejected = (error: unknown): void => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      options.onRejected(normalized);
    } catch {
      // Reporting must not tear down the watcher or replace the primary error.
    }
  };
  const onAbort = (): void => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = undefined;
    wake?.();
    wake = undefined;
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  let watcher: DeviceWatchHandle | undefined;

  try {
    watcher = options.watch(requestBuild, reportRejected);
    while (!options.signal.aborted) {
      if (!pending) {
        await new Promise<void>((resolve) => { wake = resolve; });
        continue;
      }
      pending = false;
      try {
        const bundle = await options.build(generation);
        if (bundle.manifest.sha256 === acceptedSha256) continue;
        const result = await options.push(bundle);
        acceptedSha256 = bundle.manifest.sha256;
        generation = result.generation + 1;
        options.onAccepted(result);
      } catch (error) {
        reportRejected(error);
      }
    }
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    watcher?.close();
  }
}
