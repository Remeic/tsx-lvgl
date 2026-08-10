import type { BoardPlatformAdapter, NativeBoardEvent, NativeBoardRequest, NativeCapabilityDescriptor } from "./native.js";

export interface MemoryBoardAdapterOptions { readonly descriptors: readonly NativeCapabilityDescriptor[]; readonly cached?: ReadonlyMap<string, NativeBoardEvent>; }

/** Deterministic bounded-envelope adapter used by contract tests and host fixtures. */
export class MemoryBoardAdapter implements BoardPlatformAdapter {
  private readonly cached = new Map<string, NativeBoardEvent>();
  private readonly active = new Map<number, string>();
  private listener: ((event: NativeBoardEvent) => void) | undefined;
  private nextHandle = 1;
  private disposed = false;
  public readonly submitted: NativeBoardRequest[] = [];
  public readonly cancelled: number[] = [];
  public constructor(private readonly options: MemoryBoardAdapterOptions) { for (const [id, event] of options.cached ?? []) this.cached.set(id, cloneEvent(event)); }
  public list(): readonly NativeCapabilityDescriptor[] { return this.options.descriptors.map((item) => Object.freeze({ ...item })); }
  public readCached(instanceId: string): NativeBoardEvent | undefined { const event = this.cached.get(instanceId); return event === undefined ? undefined : cloneEvent(event); }
  public submit(request: NativeBoardRequest): number { if (this.disposed) throw new Error("board adapter is disposed"); const handle = this.nextHandle++; this.active.set(handle, request.instanceId); this.submitted.push(Object.freeze({ ...request })); return handle; }
  public cancel(handle: number): void { if (this.active.delete(handle)) this.cancelled.push(handle); }
  public setSink(listener: (event: NativeBoardEvent) => void): void { if (this.disposed) throw new Error("board adapter is disposed"); this.listener = listener; }
  public emit(event: NativeBoardEvent): void { const instanceId = this.active.get(event.handle); if (this.disposed || instanceId === undefined) return; this.cached.set(instanceId, cloneEvent(event)); this.listener?.(cloneEvent(event)); }
  public activeHandleCount(): number { return this.active.size; }
  public dispose(): void { this.disposed = true; this.active.clear(); this.listener = undefined; }
}
export function encodeBoardPayload(value: Record<string, unknown>): Uint8Array { const text = JSON.stringify(value); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i += 1) { const code = text.charCodeAt(i); if (code > 0x7f) throw new Error("board payload must be ASCII"); bytes[i] = code; } return bytes; }
export function decodeBoardPayload(payload: Uint8Array): Record<string, unknown> | undefined { let text = ""; for (const byte of payload) { if (byte > 0x7f) return undefined; text += String.fromCharCode(byte); } try { const value: unknown = JSON.parse(text); return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; } catch { return undefined; } }
function cloneEvent(event: NativeBoardEvent): NativeBoardEvent { return { ...event, payload: event.payload.slice() }; }
