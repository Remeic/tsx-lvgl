/**
 * Shared fixed-step timer-advance loop used by `ManualScheduler.advance`
 * (harness.tsx) and `FakeNativeTimers.advance` (fake-native.ts). Not a
 * `*.test.*` file, so `node --test` does not pick it up on its own.
 */

export interface AdvanceableTimer {
  callback: () => void;
  periodMs: number;
  elapsedMs: number;
}

/**
 * Accumulates `milliseconds` of elapsed time onto every timer and fires
 * `callback` once per full period elapsed, carrying any remainder forward.
 */
export function advanceTimers(timers: Iterable<AdvanceableTimer>, milliseconds: number): void {
  for (const timer of timers) {
    timer.elapsedMs += milliseconds;
    while (timer.elapsedMs >= timer.periodMs) {
      timer.elapsedMs -= timer.periodMs;
      timer.callback();
    }
  }
}
