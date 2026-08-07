import type { RuntimeScheduler } from "@tsx-lvgl/runtime";
import type { NativeTimers } from "./native.js";

/**
 * The device-side `RuntimeScheduler`: `enqueue` feeds a FIFO drained once per
 * pump cycle (`drain`), and `setInterval`/`clearInterval` delegate straight
 * to the native timer ABI. A task enqueued while `drain` is running is not
 * part of the snapshot being drained, so it waits for the next `drain` call
 * — this is what fences a stale re-render from re-entering the same flush.
 */
export function createDeviceScheduler(timers: NativeTimers): RuntimeScheduler & { drain(): void } {
  const queue: Array<() => void> = [];

  return {
    enqueue(task: () => void): void {
      queue.push(task);
    },

    setInterval(task: () => void, periodMs: number): unknown {
      return timers.setInterval(task, periodMs);
    },

    clearInterval(handle: unknown): void {
      timers.clearInterval(handle as number);
    },

    drain(): void {
      // Stryker disable next-line ConditionalExpression: idle early-return is a pure allocation optimization; behavior is identical without it
      if (queue.length === 0) return;
      const pending = queue.splice(0, queue.length);
      for (const task of pending) {
        task();
      }
    },
  };
}
