/** @jsxImportSource @tsx-lvgl/core */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Button, Fragment, Screen, Text, View, createVNode, type VNode } from "@tsx-lvgl/core";
import {
  Runtime,
  useEffect,
  useInterval,
  useSensor,
  useShake,
  useState,
  useWifi,
  type RuntimeHostInstance,
} from "@tsx-lvgl/runtime";
import { motionSchema, type SensorSchema } from "@tsx-lvgl/sensors";
import type { CapabilityRuntime } from "@tsx-lvgl/capabilities";
import { MemoryWifiService, type WifiController } from "@tsx-lvgl/connectivity";
import {
  FakeHost,
  FakeSensor,
  ManualScheduler,
  createHarness,
  sample,
  sensorCapabilities,
  uptimeSchema,
} from "./support/harness.js";

class ThrowingDisposeHost extends FakeHost {
  throwOn: RuntimeHostInstance | undefined;

  override dispose(instance: RuntimeHostInstance): void {
    super.dispose(instance);
    if (instance === this.throwOn) throw new Error("old host dispose failed");
  }
}

class PartiallySwitchingHost extends FakeHost {
  throwOnNextReplace = false;

  override replaceRoot(next: RuntimeHostInstance | null, previous: RuntimeHostInstance | null): void {
    super.replaceRoot(next, previous);
    if (this.throwOnNextReplace) {
      this.throwOnNextReplace = false;
      throw new Error("root replace failed after native switch");
    }
  }
}

class RestoreThrowingHost extends FakeHost {
  private replaceCalls = 0;

  override replaceRoot(next: RuntimeHostInstance | null, previous: RuntimeHostInstance | null): void {
    this.replaceCalls += 1;
    super.replaceRoot(next, previous);
    if (this.replaceCalls === 2 || this.replaceCalls === 3) {
      throw new Error("root restore failed");
    }
  }
}

test("runtime exposes lifecycle seams and rejects invalid ownership transitions", () => {
  const { host, scheduler, runtime, errors } = createHarness();

  assert.equal(runtime.epoch, 0);
  assert.equal(runtime.host, host);
  assert.equal(runtime.scheduler, scheduler);
  runtime.unmount();
  runtime.reportError("direct error");
  assert.deepEqual(errors, ["direct error"]);
  assert.doesNotThrow(() => new Runtime({ host: new FakeHost(), scheduler: new ManualScheduler() }).reportError("ignored"));

  const session = runtime.mount(<Screen><Text text="live" /></Screen>);
  const sessionRoot = host.roots[0];
  assert.ok(sessionRoot);
  assert.equal(runtime.epoch, 1);
  assert.throws(() => runtime.mount(<Screen><Text text="duplicate" /></Screen>), /already has a mounted root/);

  runtime.sessionDisposed({ epoch: 99, root: session.root, dispose: () => undefined });
  assert.throws(() => runtime.mount(<Screen><Text text="still-owned" /></Screen>), /already has a mounted root/);

  session.dispose();
  assert.equal(host.roots.length, 0);
  assert.equal(host.removals.some((removal) => removal.parent === null && removal.child === sessionRoot), true);
  assert.doesNotThrow(() => runtime.mount(<Screen><Text text="reused" /></Screen>));
  assert.equal(runtime.epoch, 2);
  const recoveredRoot = host.roots[0];
  assert.ok(recoveredRoot);
  const removalsBeforeUnmount = host.removals.length;
  runtime.unmount();
  assert.equal(
    host.removals.slice(removalsBeforeUnmount).filter((removal) => removal.child === recoveredRoot).length,
    1,
  );
  runtime.unmount();
});

test("mount failure rolls back the attached root and leaves the runtime reusable", () => {
  const { host, runtime, errors } = createHarness();

  function Failing(): VNode {
    useEffect(() => {
      throw new Error("mount effect failed");
    }, []);
    return <Screen><Text text="candidate" /></Screen>;
  }

  assert.throws(() => runtime.mount(<Failing />), /mount effect failed/);
  assert.equal(host.roots.length, 0);
  assert.deepEqual(host.replacedRoots.at(-1), { previous: host.latest("Screen") ?? null, next: null });
  assert.equal(host.latest("Screen")?.disposed, true);
  assert.equal(runtime.epoch, 0);
  assert.deepEqual(errors, []);
  runtime.mount(<Screen><Text text="recovered" /></Screen>);
  runtime.unmount();
});

test("runtime rejects zero-root and multi-root component output", () => {
  const { host, runtime } = createHarness();

  function Empty(): VNode {
    return <></>;
  }
  function Multiple(): VNode {
    return <><Screen /><Screen /></>;
  }

  assert.throws(() => runtime.mount(<Empty />), /exactly one host instance/);
  assert.equal(host.replacedRoots.length, 0);
  assert.throws(() => runtime.mount(<Multiple />), /exactly one host instance/);
  assert.equal(host.replacedRoots.length, 0);
  assert.equal(host.removals.length, 0, "a candidate that never attached must not detach host roots");
  assert.equal(host.roots.length, 0);
  assert.equal(host.created.filter((instance) => instance.type === "Screen").every((instance) => instance.disposed), true);

  function Single(): VNode {
    return <><Screen><Text text="single-fragment" /></Screen></>;
  }
  runtime.mount(<Single />);
  assert.equal(host.text(), "single-fragment");
  runtime.unmount();
});

test("failed child mounts dispose siblings mounted earlier in the same reconciliation", () => {
  const { host, runtime } = createHarness();

  function Broken(): VNode {
    throw new Error("child render failed");
  }

  function App(): VNode {
    return <Screen><Text text="must-dispose" /><Broken /></Screen>;
  }

  assert.throws(() => runtime.mount(<App />), /child render failed/);
  const earlierSibling = host.created.find(
    (instance) => instance.type === "Text" && instance.props.text === "must-dispose",
  );
  assert.ok(earlierSibling);
  assert.equal(earlierSibling.disposed, true);
  assert.equal(host.removals.some((removal) => removal.child === earlierSibling), false);
  assert.equal(host.roots.length, 0);
});

test("runtime mounts, updates, schedules timers, reads typed sensors, and disposes the app", () => {
  const sensor = new FakeSensor();
  const { host, scheduler, runtime } = createHarness({ capabilities: sensorCapabilities(sensor) });

  function Counter(): VNode {
    const [count, setCount] = useState(0);
    const currentSample = useSensor(uptimeSchema);
    useInterval(() => setCount((value) => value + 1), 1000);
    return (
      <Screen>
        <Text text={`count=${count} uptime=${currentSample?.value ?? "?"}`} />
        <Button label="increment" onClick={() => setCount((value) => value + 1)} />
      </Screen>
    );
  }

  runtime.mount(<Counter />);

  assert.equal(host.text(), "count=0 uptime=?");
  assert.equal(scheduler.activeTimerCount, 1);
  assert.equal(sensor.listeners.length, 1);

  host.click("increment");
  scheduler.flush();
  assert.equal(host.text(), "count=1 uptime=?");

  scheduler.advance(1000);
  scheduler.flush();
  assert.equal(host.text(), "count=2 uptime=?");

  const context = sensor.contexts.at(-1);
  assert.ok(context);
  sensor.emit(sample(context, 2, 123));
  scheduler.flush();
  assert.equal(host.text(), "count=2 uptime=123");

  runtime.unmount();
  assert.equal(scheduler.activeTimerCount, 0);
  assert.equal(sensor.listeners.length, 0);
  assert.equal(host.created.filter((instance) => instance.disposed).length, 3);
});

test("missing sensor capabilities are a clean unavailable state", () => {
  const { host, runtime } = createHarness();

  function App(): VNode {
    const currentSample = useSensor(uptimeSchema);
    return <Screen><Text text={currentSample === undefined ? "unavailable" : "unexpected"} /></Screen>;
  }

  assert.equal(runtime.capabilities.sensors.get(uptimeSchema), undefined);
  runtime.mount(<App />);
  assert.equal(host.text(), "unavailable");
  runtime.unmount();
});

test("sensor reads and callbacks are fenced by cancellation, while active failures reach onError", async () => {
  const sensor = new FakeSensor({ deferred: true });
  const { host, scheduler, runtime, errors } = createHarness({ capabilities: sensorCapabilities(sensor) });

  function App(): VNode {
    const currentSample = useSensor(uptimeSchema);
    return <Screen><Text text={String(currentSample?.value ?? "pending")} /></Screen>;
  }

  runtime.mount(<App />);
  const context = sensor.contexts[0];
  const listener = sensor.listeners[0];
  assert.ok(context);
  assert.ok(listener);
  sensor.emit({ ...sample(context, 1, 77), reloadEpoch: context.reloadEpoch + 1 });
  scheduler.flush();
  assert.equal(host.text(), "pending");
  runtime.unmount();
  listener(sample(context, 2, 88));
  sensor.reject(new Error("cancelled sensor read"));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(errors, []);

  runtime.mount(<App />);
  sensor.reject(new Error("sensor read failed"));
  await Promise.resolve();
  await Promise.resolve();
  assert.match(String(errors.at(-1)), /sensor read failed/);
  runtime.unmount();
});

test("changing a sensor schema replaces the subscription and cancels the old one", () => {
  const alternateSchema: SensorSchema<number> = {
    id: "board.temperature",
    version: 1,
    unit: "celsius",
    validate: (value: unknown): value is number => typeof value === "number",
  };
  const first = new FakeSensor();
  const second = new FakeSensor({ schema: alternateSchema });
  const { host, scheduler, runtime } = createHarness({ capabilities: sensorCapabilities(first, second) });

  function App(): VNode {
    const [schema, setSchema] = useState<SensorSchema<number>>(uptimeSchema);
    const currentSample = useSensor(schema);
    return (
      <Screen>
        <Text text={String(currentSample?.value ?? "pending")} />
        <Button label="switch-sensor" onClick={() => setSchema(alternateSchema)} />
      </Screen>
    );
  }

  runtime.mount(<App />);
  const oldContext = first.contexts[0];
  const oldListener = first.listeners[0];
  assert.ok(oldContext);
  assert.ok(oldListener);
  assert.equal(first.listeners.length, 1);
  assert.equal(second.listeners.length, 0);
  host.click("switch-sensor");
  scheduler.flush();
  assert.equal(first.listeners.length, 0);
  assert.equal(second.listeners.length, 1);
  oldListener(sample(oldContext, 2, 99));
  scheduler.flush();
  assert.equal(host.text(), "pending");
  runtime.unmount();
});

test("queued updates coalesce, stale setters are fenced, and render errors are reported", () => {
  const { host, scheduler, runtime, errors } = createHarness();

  function Counter(): VNode {
    const [count, setCount] = useState(0);
    return (
      <Screen>
        <Text text={`count=${count}`} />
        <Button label="increment" onClick={() => setCount((value) => value + 1)} />
      </Screen>
    );
  }

  runtime.mount(<Counter />);
  const staleCallback = host.latest("Button")?.props.onClick as () => void;
  staleCallback();
  staleCallback();
  assert.equal(scheduler.queuedTaskCount, 1);
  scheduler.flush();
  assert.equal(host.text(), "count=2");
  runtime.unmount();
  staleCallback();
  scheduler.flush();
  assert.equal(host.text(), "");

  runtime.mount(<Counter />);
  const pendingCallback = host.live("Button")?.props.onClick as () => void;
  pendingCallback();
  assert.equal(scheduler.queuedTaskCount, 1);
  runtime.unmount();
  scheduler.flush();
  assert.equal(scheduler.queuedTaskCount, 0);

  const directlyDisposed = runtime.mount(<Counter />);
  const directCallback = host.live("Button")?.props.onClick as () => void;
  directCallback();
  directlyDisposed.dispose();
  scheduler.flush();
  assert.deepEqual(errors, []);
  const disposedInternals = directlyDisposed as unknown as {
    isActive(): boolean;
    isAttached(): boolean;
    requestUpdate(fiber: { active: boolean }): void;
  };
  assert.equal(disposedInternals.isActive(), false);
  assert.equal(disposedInternals.isAttached(), false);
  disposedInternals.requestUpdate({ active: true });
  assert.equal(scheduler.queuedTaskCount, 0, "a disposed session must reject stale update requests");

  function ThrowsOnUpdate(): VNode {
    const [broken, setBroken] = useState(false);
    if (broken) throw new Error("render update failed");
    return <Screen><Button label="break" onClick={() => setBroken(true)} /></Screen>;
  }

  runtime.mount(<ThrowsOnUpdate />);
  host.click("break");
  scheduler.flush();
  assert.match(String(errors.at(-1)), /render update failed/);
  runtime.unmount();
});

test("reload swaps the root transactionally and fences stale callbacks on rollback", () => {
  const { host, scheduler, runtime } = createHarness();

  runtime.mount(
    <Screen>
      <Text text="old" />
      <Button label="old-button" onClick={() => undefined} />
    </Screen>,
  );
  const staleButton = host.latest("Button");
  assert.ok(staleButton);
  const staleCallback = staleButton.props.onClick as () => void;

  const committed = runtime.reload(<Screen><Text text="new" /></Screen>);
  assert.equal(committed.status, "committed");
  assert.equal(committed.epoch, 2);
  assert.equal(host.text(), "new");
  const newRoot = host.latest("Screen");
  assert.ok(newRoot);
  assert.deepEqual(host.replacedRoots.at(-1), { previous: host.created[0], next: newRoot });

  staleCallback();
  scheduler.flush();
  assert.equal(host.text(), "new");

  function Broken(): VNode {
    throw new Error("broken bundle");
  }
  const rolledBack = runtime.reload(<Broken />);
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(rolledBack.epoch, 2);
  assert.equal(host.text(), "new");
  assert.match(String(rolledBack.error), /broken bundle/);
});

test("reload restores the previous root when host replacement throws after switching", () => {
  const host = new PartiallySwitchingHost();
  const scheduler = new ManualScheduler();
  const runtime = new Runtime({ host, scheduler });

  runtime.mount(<Screen><Text text="stable" /></Screen>);
  const previousRoot = host.roots[0];
  assert.ok(previousRoot);
  host.throwOnNextReplace = true;

  const result = runtime.reload(<Screen><Text text="candidate" /></Screen>);

  assert.equal(result.status, "rolled_back");
  assert.match(String(result.error), /root replace failed/);
  assert.deepEqual(host.roots, [previousRoot]);
  assert.equal(host.text(), "stable");
  runtime.unmount();
});

test("reload reports a failed previous-root restore without leaking the candidate", () => {
  const host = new RestoreThrowingHost();
  const scheduler = new ManualScheduler();
  const errors: unknown[] = [];
  const runtime = new Runtime({ host, scheduler, onError: (error) => errors.push(error) });

  runtime.mount(<Screen><Text text="stable" /></Screen>);
  const result = runtime.reload(<Screen><Text text="candidate" /></Screen>);

  assert.equal(result.status, "rolled_back");
  assert.match(String(result.error), /root restore failed/);
  assert.deepEqual(errors, [new Error("root restore failed")]);
  assert.equal(host.created.filter((instance) => instance.props.text === "candidate").every((instance) => instance.disposed), true);
  runtime.unmount();
});

test("effect activation failure restores the previous root and disposes the candidate", () => {
  const { host, runtime } = createHarness();

  runtime.mount(<Screen><Text text="stable" /></Screen>);
  const previousRoot = host.roots[0];
  assert.ok(previousRoot);

  function Failing(): VNode {
    useEffect(() => {
      throw new Error("effect activation failed");
    }, []);
    return <Screen><Text text="candidate" /></Screen>;
  }

  const result = runtime.reload(<Failing />);
  assert.equal(result.status, "rolled_back");
  assert.equal(result.epoch, 1);
  assert.match(String(result.error), /effect activation failed/);
  assert.deepEqual(host.roots, [previousRoot]);
  assert.equal(previousRoot.disposed, false);
  assert.equal(host.text(), "stable");

  const candidateRoot = host.latest("Screen");
  const candidateText = host.created.filter((instance) => instance.type === "Text" && instance.props.text === "candidate").at(-1);
  assert.ok(candidateRoot);
  assert.ok(candidateText);
  assert.equal(candidateRoot.disposed, true);
  assert.equal(candidateText.disposed, true);
  assert.equal(host.removals.some((removal) => removal.parent === candidateRoot && removal.child === candidateText), true);
  runtime.unmount();
});

test("effect activation rollback fences the candidate board epoch", () => {
  const host = new FakeHost();
  const scheduler = new ManualScheduler();
  const rolledBack: number[] = [];
  const board: CapabilityRuntime = {
    getBinding: () => ({ state: { status: "unsupported", reason: "not-implemented" }, instances: [] }),
    subscribe: (_schema, _options, _context, onState) => { onState({ state: { status: "unsupported", reason: "not-implemented" }, instances: [] }); return { cancel: () => undefined }; },
    diagnostics: () => ({ effectivePeriodsMs: {}, queueDepth: 0, queueHighWater: 0, droppedEvents: 0, activeOwners: [], resourceUse: { observers: 0 } }),
    commitEpoch: () => undefined,
    rollbackEpoch: (epoch) => { rolledBack.push(epoch); },
    dispose: () => undefined,
  };
  const runtime = new Runtime({ host, scheduler, board });
  runtime.mount(<Screen><Text text="stable" /></Screen>);
  function Failing(): VNode {
    useEffect(() => { throw new Error("effect activation failed"); }, []);
    return <Screen><Text text="candidate" /></Screen>;
  }

  assert.equal(runtime.reload(<Failing />).status, "rolled_back");
  assert.deepEqual(rolledBack, [2]);
});

test("reload works without a previous epoch and advances the epoch after commit", () => {
  const { host, runtime } = createHarness();

  function Root(): VNode {
    return <Screen><Text text="first" /></Screen>;
  }
  const first = runtime.reload(<Root />);
  assert.deepEqual(first, { status: "committed", epoch: 1 });
  assert.equal(runtime.epoch, 1);
  assert.deepEqual(host.rootInsertionsOutsideReplace, []);
  const second = runtime.reload(<Screen><Text text="second" /></Screen>);
  assert.deepEqual(second, { status: "committed", epoch: 2 });
  assert.equal(runtime.epoch, 2);
  assert.equal(host.text(), "second");
  runtime.unmount();

  function BrokenEffect(): VNode {
    useEffect(() => {
      throw new Error("reload effect failed");
    }, []);
    return <Screen><Text text="broken" /></Screen>;
  }
  const failed = runtime.reload(<BrokenEffect />);
  assert.equal(failed.status, "rolled_back");
  assert.equal(failed.epoch, 2);
  assert.equal(host.roots.length, 0);
  assert.deepEqual(host.replacedRoots.at(-1), {
    previous: host.latest("Screen"),
    next: null,
  });
});

test("effects rerun only when dependencies change and cleanup is idempotent", () => {
  const { host, scheduler, runtime } = createHarness();
  let effectRuns = 0;
  let cleanupRuns = 0;
  let optionalDependencyRuns = 0;
  let shapeDependencyRuns = 0;

  function App(): VNode {
    const [value, setValue] = useState(0);
    const [tick, setTick] = useState(false);
    useEffect(() => {
      effectRuns += 1;
      return () => {
        cleanupRuns += 1;
      };
    }, [value]);
    useEffect(() => {
      if (tick) return undefined;
      return undefined;
    }, []);
    useEffect(() => {
      optionalDependencyRuns += 1;
    }, tick ? [value] : undefined);
    useEffect(() => {
      shapeDependencyRuns += 1;
    }, tick ? [] : [undefined]);
    return (
      <Screen>
        <Text text={`${value}:${tick}`} />
        <Button label="same" onClick={() => setTick((current) => !current)} />
        <Button label="change" onClick={() => setValue((current) => current + 1)} />
      </Screen>
    );
  }

  const session = runtime.mount(<App />);
  assert.equal(effectRuns, 1);
  assert.equal(optionalDependencyRuns, 1);
  assert.equal(shapeDependencyRuns, 1);
  host.click("same");
  scheduler.flush();
  assert.equal(effectRuns, 1);
  assert.equal(optionalDependencyRuns, 2);
  assert.equal(shapeDependencyRuns, 2);
  assert.equal(cleanupRuns, 0);
  host.click("same");
  scheduler.flush();
  assert.equal(optionalDependencyRuns, 3);
  host.click("change");
  scheduler.flush();
  assert.equal(effectRuns, 2);
  assert.equal(cleanupRuns, 1);
  session.dispose();
  session.dispose();
  assert.equal(cleanupRuns, 2);
  assert.equal(scheduler.activeTimerCount, 0);
});

test("hook order changes and calls outside render are reported as contract errors", () => {
  const { host, scheduler, runtime, errors } = createHarness();

  assert.throws(() => useState(0), /useState must be called while rendering a component/);
  assert.throws(() => useEffect(() => undefined), /useEffect must be called while rendering a component/);
  assert.throws(() => useInterval(() => undefined, 1), /useInterval must be called while rendering a component/);
  assert.throws(() => useSensor(uptimeSchema), /useSensor must be called while rendering a component/);
  assert.throws(() => useInterval(() => undefined, 0), /useInterval period must be a positive integer/);
  assert.throws(() => useInterval(() => undefined, -1), /useInterval period must be a positive integer/);
  assert.throws(() => useInterval(() => undefined, 1.5), /useInterval period must be a positive integer/);

  function LazyState(): VNode {
    const [value] = useState(() => 7);
    return <Screen><Text text={value} /></Screen>;
  }
  runtime.mount(<LazyState />);
  assert.equal(host.text(), "7");
  runtime.unmount();

  function BadHook(): VNode {
    const [changed, setChanged] = useState(false);
    if (changed) useEffect(() => undefined, []);
    else useState(0);
    return <Screen><Button label="change-hook" onClick={() => setChanged(true)} /></Screen>;
  }

  runtime.mount(<BadHook />);
  host.click("change-hook");
  scheduler.flush();
  assert.match(String(errors.at(-1)), /Hook order changed: expected effect hook/);
  runtime.unmount();

  function BadStateHook(): VNode {
    const [changed, setChanged] = useState(false);
    if (changed) useState(0);
    else useEffect(() => undefined, []);
    return <Screen><Button label="change-state-hook" onClick={() => setChanged(true)} /></Screen>;
  }

  runtime.mount(<BadStateHook />);
  host.click("change-state-hook");
  scheduler.flush();
  assert.match(String(errors.at(-1)), /Hook order changed: expected state hook/);
  runtime.unmount();
});

test("interval validation, callback replacement, and inactive callback fencing are deterministic", () => {
  const { host, scheduler, runtime } = createHarness();
  let callbackRuns = 0;

  function App(): VNode {
    const [count, setCount] = useState(0);
    useInterval(() => {
      callbackRuns += 1;
      setCount(count + 1);
    }, 100);
    return <Screen><Text text={`count=${count}`} /></Screen>;
  }

  runtime.mount(<App />);
  scheduler.advance(100);
  scheduler.flush();
  assert.equal(host.text(), "count=1");
  scheduler.advance(100);
  scheduler.flush();
  assert.equal(host.text(), "count=2");
  const callback = scheduler.latestIntervalCallback;
  runtime.unmount();
  callback?.();
  scheduler.flush();
  assert.equal(host.text(), "");
  assert.equal(callbackRuns, 2);
});

test("interval callbacks are fenced when their child fiber is removed", () => {
  const { host, scheduler, runtime } = createHarness();
  let callbackRuns = 0;

  function Ticker(): VNode {
    useInterval(() => {
      callbackRuns += 1;
    }, 100);
    return <Text text="ticker" />;
  }

  function App(): VNode {
    const [visible, setVisible] = useState(true);
    return (
      <Screen>
        {visible ? <Ticker /> : null}
        <Button label="hide-ticker" onClick={() => setVisible(false)} />
      </Screen>
    );
  }

  runtime.mount(<App />);
  const staleCallback = scheduler.latestIntervalCallback;
  assert.ok(staleCallback);
  host.click("hide-ticker");
  scheduler.flush();
  assert.equal(scheduler.activeTimerCount, 0);
  staleCallback();
  assert.equal(callbackRuns, 0);
  runtime.unmount();
});

test("a removed fiber fences its state updater before executing stale work", () => {
  const { host, scheduler, runtime } = createHarness();
  let updaterRuns = 0;

  function Child(): VNode {
    const [value, setValue] = useState(0);
    return (
      <Button
        label={`child:${value}`}
        onClick={() => setValue((previous) => {
          updaterRuns += 1;
          return previous + 1;
        })}
      />
    );
  }

  function App(): VNode {
    const [visible, setVisible] = useState(true);
    return (
      <Screen>
        {visible ? <Child /> : null}
        <Button label="remove-child" onClick={() => setVisible(false)} />
      </Screen>
    );
  }

  runtime.mount(<App />);
  const staleButton = host.created.find((instance) => instance.type === "Button" && instance.props.label === "child:0");
  assert.ok(staleButton);
  const staleCallback = staleButton.props.onClick as () => void;
  host.click("remove-child");
  scheduler.flush();
  staleCallback();
  assert.equal(updaterRuns, 0);
  assert.equal(scheduler.queuedTaskCount, 0);
  runtime.unmount();
});

test("changing an interval period replaces the native timer exactly once", () => {
  const { host, scheduler, runtime } = createHarness();

  function App(): VNode {
    const [period, setPeriod] = useState(100);
    useInterval(() => undefined, period);
    return (
      <Screen>
        <Button label="change-period" onClick={() => setPeriod(200)} />
        <Text text={String(period)} />
      </Screen>
    );
  }

  runtime.mount(<App />);
  assert.deepEqual(scheduler.issuedHandles, [1]);
  host.click("change-period");
  scheduler.flush();
  assert.deepEqual(scheduler.issuedHandles, [1, 2]);
  assert.equal(scheduler.activeTimerCount, 1);
  runtime.unmount();
});

test("useInterval keeps its timer stable across renders and always invokes the latest render's callback", () => {
  const { host, scheduler, runtime } = createHarness();
  const invoked: number[] = [];

  function App(): VNode {
    const [count, setCount] = useState(0);
    // A fresh inline arrow every render must not tear down and recreate the timer.
    useInterval(() => invoked.push(count), 100);
    return (
      <Screen>
        <Text text={`count=${count}`} />
        <Button label="bump" onClick={() => setCount((value) => value + 1)} />
      </Screen>
    );
  }

  runtime.mount(<App />);
  assert.equal(scheduler.issuedHandles.length, 1);

  host.click("bump");
  scheduler.flush();
  assert.equal(host.text(), "count=1");
  assert.equal(scheduler.issuedHandles.length, 1, "re-rendering must not issue a new timer handle");
  assert.equal(scheduler.activeTimerCount, 1);

  scheduler.advance(100);
  assert.deepEqual(invoked, [1], "the fired callback must close over the latest render's state");

  runtime.unmount();
  assert.equal(scheduler.activeTimerCount, 0);
});

test("state setters stay stable and same-value updates do not schedule work", () => {
  const { host, scheduler, runtime } = createHarness();
  let setterEffectRuns = 0;

  function App(): VNode {
    const [value, setValue] = useState(0);
    const [tick, setTick] = useState(false);
    useEffect(() => {
      setterEffectRuns += 1;
    }, [setValue]);
    return (
      <Screen>
        <Text text={`${value}:${tick}`} />
        <Button label="same-state" onClick={() => setValue(0)} />
        <Button label="rerender" onClick={() => setTick((current) => !current)} />
      </Screen>
    );
  }

  runtime.mount(<App />);
  assert.equal(setterEffectRuns, 1);
  host.click("same-state");
  assert.equal(scheduler.queuedTaskCount, 0);
  host.click("rerender");
  scheduler.flush();
  assert.equal(setterEffectRuns, 1);
  runtime.unmount();
});

test("a state update re-renders only its own fiber, leaving unrelated siblings untouched", () => {
  const { host, scheduler, runtime } = createHarness();
  let siblingRenders = 0;

  function Sibling(): VNode {
    siblingRenders += 1;
    return <Text text="static" />;
  }

  function Counter(): VNode {
    const [count, setCount] = useState(0);
    return (
      <>
        <Text text={`count=${count}`} />
        <Button label="increment" onClick={() => setCount((value) => value + 1)} />
      </>
    );
  }

  function App(): VNode {
    return (
      <Screen>
        <Counter />
        <Sibling />
      </Screen>
    );
  }

  runtime.mount(<App />);
  assert.equal(siblingRenders, 1);
  host.click("increment");
  scheduler.flush();
  assert.equal(host.text(), "count=1 | static");
  assert.equal(siblingRenders, 1, "Sibling must not re-render when Counter's own state changes");
  runtime.unmount();
});

test("host reorder is skipped for a pure prop update, but happens on insertion, growth, and reordering", () => {
  const { host, scheduler, runtime } = createHarness();

  function App(): VNode {
    const [items, setItems] = useState(["a", "b"]);
    const [label, setLabel] = useState("x");
    return (
      <Screen>
        <Text text={label} />
        <Button label="relabel" onClick={() => setLabel((value) => `${value}!`)} />
        <Button label="reverse" onClick={() => setItems((value) => [...value].reverse())} />
        <Button label="grow" onClick={() => setItems((value) => [...value, "c"])} />
        <Button label="remove" onClick={() => setItems((value) => value.slice(0, -1))} />
        <Button label="replace" onClick={() => setItems(["a", "replacement"])} />
        <View>
          {items.map((item) => <Text key={item} text={item} />)}
        </View>
      </Screen>
    );
  }

  runtime.mount(<App />);
  const afterMount = host.insertions.length;

  host.click("relabel");
  scheduler.flush();
  assert.equal(host.insertions.length, afterMount, "a pure prop/text update must not reorder host children");

  const beforeReplace = host.insertions.length;
  host.click("replace");
  scheduler.flush();
  assert.ok(host.insertions.length > beforeReplace, "a keyed replacement must resubmit the changed host order");

  host.click("reverse");
  scheduler.flush();
  assert.ok(host.insertions.length > afterMount, "reordering keyed children must resubmit host order");
  const afterReverse = host.insertions.length;

  host.click("grow");
  scheduler.flush();
  assert.ok(host.insertions.length > afterReverse, "inserting a child must resubmit host order");

  const beforeShrink = host.insertions.length;
  host.click("remove");
  scheduler.flush();
  assert.ok(host.insertions.length > beforeShrink, "removing a child must resubmit the remaining host order");

  runtime.unmount();
});

test("keyed component children preserve state while their host order changes", () => {
  const { host, scheduler, runtime } = createHarness();

  function Item(props: { readonly label: string }): VNode {
    const [clicks, setClicks] = useState(0);
    return <Button label={`${props.label}:${clicks}`} onClick={() => setClicks((value) => value + 1)} />;
  }

  function List(): VNode {
    const [order, setOrder] = useState(["a", "b"]);
    return (
      <Screen>
        <Button label="swap" onClick={() => setOrder((value) => [...value].reverse())} />
        <View>
          {order.map((label) => <Item key={label} label={label} />)}
        </View>
      </Screen>
    );
  }

  runtime.mount(<List />);
  host.click("a:0");
  scheduler.flush();
  host.click("swap");
  scheduler.flush();

  const view = host.live("View");
  assert.ok(view);
  assert.deepEqual(view.children.map((child) => child.props.label), ["b:0", "a:1"]);
  runtime.unmount();
});

test("host props distinguish equal, changed, and shape-changing updates", () => {
  const { host, scheduler, runtime } = createHarness();

  function App(): VNode {
    const [sameTick, setSameTick] = useState(false);
    const [changed, setChanged] = useState(false);
    const [expanded, setExpanded] = useState(false);
    return (
      <Screen>
        {createVNode("View", { value: 1, stable: "same" })}
        {createVNode("View", changed ? { value: 2, stable: "same" } : { value: 1, stable: "same" })}
        {createVNode("View", expanded ? { value: 1, stable: "same", extra: true } : { value: 1, stable: "same" })}
        {createVNode("View", expanded ? { value: undefined, extra: undefined } : { value: undefined })}
        <Button label="same-props" onClick={() => setSameTick((value) => !value)} />
        <Button label="changed-props" onClick={() => setChanged(true)} />
        <Button label="expanded-props" onClick={() => setExpanded(true)} />
        <Text text={String(sameTick)} />
      </Screen>
    );
  }

  runtime.mount(<App />);
  const viewUpdates = (): number => host.updates.filter((update) => update.instance.type === "View").length;
  host.click("same-props");
  scheduler.flush();
  assert.equal(viewUpdates(), 0);
  host.click("changed-props");
  scheduler.flush();
  assert.equal(viewUpdates(), 1);
  host.click("expanded-props");
  scheduler.flush();
  assert.equal(viewUpdates(), 3);
  runtime.unmount();
});

test("component prop changes render through the component fiber without host updates", () => {
  const { host, scheduler, runtime } = createHarness();

  function Child(props: { readonly label: string }): VNode {
    return <Text text={props.label} />;
  }

  function App(): VNode {
    const [label, setLabel] = useState("first");
    return (
      <Screen>
        <Child label={label} />
        <Button label="change-component-prop" onClick={() => setLabel("second")} />
      </Screen>
    );
  }

  runtime.mount(<App />);
  host.click("change-component-prop");
  scheduler.flush();
  assert.equal(host.text(), "second");
  assert.equal(host.updates.filter((update) => update.instance.type === "Text").length, 1);
  runtime.unmount();
});

test("identity changes remount children, optional children mount/unmount, and duplicate keys fail", () => {
  const { host, scheduler, runtime } = createHarness();

  function Identity(): VNode {
    const [mode, setMode] = useState(false);
    const [show, setShow] = useState(false);
    return (
      <Screen>
        <Button label="switch-identity" onClick={() => setMode(true)} />
        <Button label="toggle-child" onClick={() => setShow((value) => !value)} />
        <View>
          {mode ? <Text key="same-key" text="new-type" /> : <Button key="same-key" label="old-type" />}
          {show ? <Text text="optional" /> : null}
        </View>
      </Screen>
    );
  }

  runtime.mount(<Identity />);
  const oldType = host.created.find((instance) => instance.type === "Button" && instance.props.label === "old-type");
  assert.ok(oldType);
  host.click("switch-identity");
  scheduler.flush();
  assert.equal(oldType.disposed, true);
  assert.equal(host.created.some((instance) => instance.type === "Text" && instance.props.text === "new-type" && !instance.disposed), true);
  host.click("toggle-child");
  scheduler.flush();
  const optional = host.created.find((instance) => instance.type === "Text" && instance.props.text === "optional");
  assert.ok(optional);
  host.click("toggle-child");
  scheduler.flush();
  assert.equal(optional.disposed, true);
  const view = host.live("View");
  assert.ok(view);
  runtime.unmount();
  assert.equal(host.removals.some((removal) => removal.parent === view), true);

  function DuplicateKeys(): VNode {
    return <Screen><Text key="duplicate" text="one" /><Text key="duplicate" text="two" /></Screen>;
  }
  assert.throws(() => runtime.mount(<DuplicateKeys />), /Duplicate child key: duplicate/);
});

test("key changes reset keyed component state", () => {
  const { host, scheduler, runtime } = createHarness();

  function Item(props: { readonly id: string }): VNode {
    const [clicks, setClicks] = useState(0);
    return <Button label={`${props.id}:${clicks}`} onClick={() => setClicks((value) => value + 1)} />;
  }
  function App(): VNode {
    const [id, setId] = useState("a");
    return <Screen><Button label="change-key" onClick={() => setId("b")} /><Item key={id} id={id} /></Screen>;
  }

  runtime.mount(<App />);
  host.click("a:0");
  scheduler.flush();
  const staleItemCallback = host.created.find((instance) => instance.type === "Button" && instance.props.label === "a:1")?.props.onClick as () => void;
  host.click("change-key");
  scheduler.flush();
  staleItemCallback();
  assert.equal(scheduler.queuedTaskCount, 0);
  assert.equal(host.created.some((instance) => instance.type === "Button" && instance.props.label === "b:0" && !instance.disposed), true);
  assert.equal(host.created.some((instance) => instance.type === "Button" && instance.props.label === "a:1" && !instance.disposed), false);
  runtime.unmount();
});

test("unkeyed children reconcile by slot instead of moving by type", () => {
  const { host, scheduler, runtime } = createHarness();

  function App(): VNode {
    const [swapped, setSwapped] = useState(false);
    return (
      <Screen>
        <Button label="swap-unkeyed" onClick={() => setSwapped(true)} />
        <View>
          {swapped
            ? <><Button label="button-first" /><Text text="text-second" /></>
            : <><Text text="text-first" /><Button label="button-second" /></>}
        </View>
      </Screen>
    );
  }

  runtime.mount(<App />);
  const oldText = host.created.find((instance) => instance.type === "Text" && instance.props.text === "text-first");
  const oldButton = host.created.find((instance) => instance.type === "Button" && instance.props.label === "button-second");
  assert.ok(oldText);
  assert.ok(oldButton);
  host.click("swap-unkeyed");
  scheduler.flush();
  assert.equal(oldText.disposed, true);
  assert.equal(oldButton.disposed, true);
  runtime.unmount();
});

test("an unkeyed child does not reuse a keyed fiber occupying the same slot", () => {
  const { host, scheduler, runtime } = createHarness();

  function App(): VNode {
    const [changed, setChanged] = useState(false);
    return (
      <Screen>
        <View>
          {changed ? <Text text="unkeyed replacement" /> : <Text key="stable-key" text="keyed original" />}
        </View>
        <Button label="remove-key" onClick={() => setChanged(true)} />
      </Screen>
    );
  }

  runtime.mount(<App />);
  const original = host.live("Text");
  assert.ok(original);
  host.click("remove-key");
  scheduler.flush();
  const replacement = host.live("Text");
  assert.ok(replacement);
  assert.notEqual(replacement, original);
  assert.equal(original.disposed, true);
  runtime.unmount();
});

test("unkeyed insertion mounts a child when its previous slot is empty", () => {
  const { host, scheduler, runtime } = createHarness();

  function App(): VNode {
    const [show, setShow] = useState(false);
    return (
      <Screen>
        <View>{show ? <Text text="inserted" /> : null}</View>
        <Button label="show-inserted" onClick={() => setShow(true)} />
      </Screen>
    );
  }

  runtime.mount(<App />);
  assert.equal(host.text(), "");
  host.click("show-inserted");
  scheduler.flush();
  assert.equal(host.text(), "inserted");
  runtime.unmount();
});

test("disposing an attached session removes roots and descendants through their host parents", () => {
  const { host, runtime } = createHarness();
  function NestedComponent(): VNode {
    return <Text text="through-components" />;
  }
  function ComponentWrapper(): VNode {
    return <NestedComponent />;
  }

  const session = runtime.mount(
    <Screen>
      <View><Text text="nested" /></View>
      <ComponentWrapper />
    </Screen>,
  );
  const root = host.live("Screen");
  const view = host.live("View");
  const text = host.created.find((instance) => instance.type === "Text" && instance.props.text === "nested");
  const componentText = host.created.find((instance) => instance.type === "Text" && instance.props.text === "through-components");
  assert.ok(root);
  assert.ok(view);
  assert.ok(text);
  assert.ok(componentText);
  session.dispose();
  assert.equal(host.removals.some((removal) => removal.parent === null && removal.child === root), true);
  assert.equal(host.removals.some((removal) => removal.parent === view && removal.child === text), true);
  assert.equal(host.removals.some((removal) => removal.parent === root && removal.child === componentText), true);
  assert.equal(host.disposals.filter((instance) => instance === root || instance === view || instance === text).length, 3);
});

test("effect cleanup and sensor cancellation happen exactly once across a committed reload", () => {
  const sensor = new FakeSensor();
  const { runtime } = createHarness({ capabilities: sensorCapabilities(sensor) });
  let effectRuns = 0;
  let cleanupRuns = 0;

  function App(): VNode {
    useEffect(() => {
      effectRuns += 1;
      return () => {
        cleanupRuns += 1;
      };
    }, []);
    useSensor(uptimeSchema);
    return <Screen><Text text="live" /></Screen>;
  }

  runtime.mount(<App />);
  const previousContext = sensor.contexts[0];
  assert.ok(previousContext);
  assert.equal(effectRuns, 1);
  assert.equal(cleanupRuns, 0);
  assert.equal(sensor.listeners.length, 1);
  assert.equal(previousContext.isCancelled(), false);

  const result = runtime.reload(<Screen><Text text="replacement" /></Screen>);
  assert.equal(result.status, "committed");
  assert.equal(cleanupRuns, 1);
  assert.equal(previousContext.isCancelled(), true);
  assert.equal(sensor.listeners.length, 0);

  runtime.unmount();
  assert.equal(cleanupRuns, 1);
});

test("a failing old cleanup does not roll back the already committed root", () => {
  const { host, runtime, errors } = createHarness();
  let laterCleanupRuns = 0;

  function Previous(): VNode {
    useEffect(() => () => {
      throw new Error("old cleanup failed");
    }, []);
    useEffect(() => () => {
      laterCleanupRuns += 1;
    }, []);
    useEffect(() => () => {
      throw new Error("later cleanup failed");
    }, []);
    return <Screen><Text text="old" /></Screen>;
  }

  runtime.mount(<Previous />);
  const previousRoot = host.live("Screen");
  assert.ok(previousRoot);

  const result = runtime.reload(<Screen><Text text="new" /></Screen>);
  assert.deepEqual(result, { status: "committed", epoch: 2 });
  assert.equal(host.text(), "new");
  assert.equal(previousRoot.disposed, true);
  assert.equal(laterCleanupRuns, 1);
  assert.match(String(errors.at(-1)), /old cleanup failed/);
  runtime.unmount();
});

test("a failing old host dispose is reported without rolling back the candidate", () => {
  const host = new ThrowingDisposeHost();
  const scheduler = new ManualScheduler();
  const errors: unknown[] = [];
  const runtime = new Runtime({ host, scheduler, onError: (error) => errors.push(error) });

  runtime.mount(<Screen><Text text="old" /></Screen>);
  host.throwOn = host.live("Screen");
  const result = runtime.reload(<Screen><Text text="new" /></Screen>);

  assert.deepEqual(result, { status: "committed", epoch: 2 });
  assert.equal(host.text(), "new");
  assert.match(String(errors.at(-1)), /old host dispose failed/);
  runtime.unmount();
});

test("coalesced updates do not re-render a fiber whose ancestor already rendered it in the same flush", () => {
  const { host, scheduler, runtime } = createHarness();
  let parentRenders = 0;
  let childRenders = 0;

  function Child(): VNode {
    childRenders += 1;
    const [count, setCount] = useState(0);
    return <Button label={`child:${count}`} onClick={() => setCount((value) => value + 1)} />;
  }

  function Parent(): VNode {
    parentRenders += 1;
    const [flag, setFlag] = useState(false);
    return (
      <Screen>
        <Button label="parent-bump" onClick={() => setFlag((value) => !value)} />
        <Text text={String(flag)} />
        <Child />
      </Screen>
    );
  }

  runtime.mount(<Parent />);
  assert.equal(parentRenders, 1);
  assert.equal(childRenders, 1);

  // Both fibers become dirty in the same synchronous batch, ahead of the single queued flush.
  host.click("child:0");
  host.click("parent-bump");
  assert.equal(scheduler.queuedTaskCount, 1);
  scheduler.flush();

  // Parent's cascading re-render already re-rendered Child; the flush loop must not do it twice.
  assert.equal(parentRenders, 2);
  assert.equal(childRenders, 2);
  const childButton = host.created.find(
    (instance) => instance.type === "Button" && !instance.disposed && String(instance.props.label).startsWith("child:"),
  );
  assert.equal(childButton?.props.label, "child:1");
  runtime.unmount();
});

test("reusing the identical VNode reference across a re-render short-circuits the prop diff", () => {
  const { host, scheduler, runtime } = createHarness();
  const staticChild = <Text text="unchanging" />;

  function App(): VNode {
    const [tick, setTick] = useState(false);
    return (
      <Screen>
        {staticChild}
        <Button label="tick" onClick={() => setTick((value) => !value)} />
      </Screen>
    );
  }

  runtime.mount(<App />);
  host.click("tick");
  scheduler.flush();
  assert.equal(
    host.updates.some((update) => update.instance.type === "Text"),
    false,
    "an identical VNode reference must never reach updateInstance",
  );
  runtime.unmount();
});

test("syncHostAncestor climbs past intermediate component ancestors to the nearest host element", () => {
  const { host, scheduler, runtime } = createHarness();

  function Leaf(): VNode {
    const [count, setCount] = useState(0);
    const [visible, setVisible] = useState(false);
    return (
      <>
        <Text text={`leaf:${count}`} />
        {visible ? <Text text="optional-leaf" /> : null}
        <Button label="bump-leaf" onClick={() => setCount((value) => value + 1)} />
        <Button label="toggle-leaf" onClick={() => setVisible((value) => !value)} />
      </>
    );
  }
  // A pure passthrough component: Leaf's fiber parent is a component fiber, not an
  // element, so resyncing Leaf's host ancestor after its own state update must walk
  // past Wrapper to reach Screen.
  function Wrapper(): VNode {
    return <Leaf />;
  }

  function App(): VNode {
    return (
      <Screen>
        <Wrapper />
      </Screen>
    );
  }

  runtime.mount(<App />);
  assert.equal(host.text(), "leaf:0");
  host.click("bump-leaf");
  scheduler.flush();
  assert.equal(host.text(), "leaf:1");
  const screen = host.live("Screen");
  assert.ok(screen);
  host.click("toggle-leaf");
  scheduler.flush();
  assert.equal(screen.children.some((child) => child.props.text === "optional-leaf"), true);
  runtime.unmount();
});

test("useShake falls back to its default cooldown when none is supplied", () => {
  const { runtime } = createHarness();
  let shake: ReturnType<typeof useShake> | undefined;
  function App(): VNode {
    shake = useShake();
    return <Screen><Text text={String(shake.count)} /></Screen>;
  }

  runtime.mount(<App />);
  assert.equal(shake!.count, 0);
  runtime.unmount();
});

test("runtime falls back to a no-op board and undefined wifi when neither is configured", () => {
  const { runtime } = createHarness();
  assert.equal(runtime.wifi, undefined);

  const binding = runtime.board.getBinding(motionSchema, { periodMs: 10 });
  assert.equal(binding.state.status, "unsupported");
  assert.deepEqual(binding.instances, []);

  const seen: string[] = [];
  const subscription = runtime.board.subscribe(
    motionSchema,
    {},
    { reloadEpoch: 0, isCancelled: () => false },
    (nextBinding) => seen.push(nextBinding.state.status),
  );
  assert.deepEqual(seen, ["unsupported"]);
  assert.doesNotThrow(() => subscription.cancel());

  assert.deepEqual(runtime.board.diagnostics(), {
    effectivePeriodsMs: {},
    queueDepth: 0,
    queueHighWater: 0,
    droppedEvents: 0,
    activeOwners: [],
    resourceUse: { observers: 0 },
  });
  assert.doesNotThrow(() => runtime.board.dispose());
});

test("useWifi reports an unsupported station and inert operations when no Wi-Fi service is configured", () => {
  const { runtime } = createHarness();
  let controller: WifiController | undefined;
  function App(): VNode {
    controller = useWifi();
    return <Screen><Text text={controller.state.status} /></Screen>;
  }

  runtime.mount(<App />);
  assert.equal(controller!.state.status, "unsupported");

  // No scan has been issued yet: cancelling is inert.
  assert.doesNotThrow(() => controller!.cancelScan());

  const scanId = controller!.scanNetworks({});
  assert.equal(scanId > 0, true);
  assert.equal(controller!.scan.status, "failed");
  assert.equal(controller!.scan.status === "failed" ? controller!.scan.issue.code : "", "unsupported");
  assert.doesNotThrow(() => controller!.cancelScan());

  const connectId = controller!.connect();
  assert.equal(connectId > 0, true);
  assert.equal(controller!.connection.status, "failed");

  const disconnectId = controller!.disconnect();
  assert.equal(disconnectId > 0, true);
  assert.notEqual(disconnectId, connectId);
  assert.equal(controller!.connection.status, "failed");

  runtime.unmount();
});

test("useWifi drives scan and connection operations through a configured Wi-Fi service", () => {
  const wifi = new MemoryWifiService();
  const { host, runtime } = createHarness({ wifi });
  let controller: WifiController | undefined;
  function App(): VNode {
    controller = useWifi();
    return <Screen><Text text={controller.state.status} /></Screen>;
  }

  runtime.mount(<App />);
  assert.equal(host.text(), "ready");

  // No scan has been issued yet: cancelling is inert (undefined operation branch).
  assert.doesNotThrow(() => controller!.cancelScan());

  const firstScanId = controller!.scanNetworks({});
  const runningScan = controller!.scan;
  assert.equal(runningScan.status, "running");
  wifi.completeScan(firstScanId, [{ id: "net", rssiDbm: -50, channel: 1, authKind: "wpa2" }]);
  const succeededScan = controller!.scan;
  assert.equal(succeededScan.status, "succeeded");

  // A second scan supersedes the first subscription/operation (defined branch).
  const secondScanId = controller!.scanNetworks({});
  assert.notEqual(secondScanId, firstScanId);
  const secondRunningScan = controller!.scan;
  assert.equal(secondRunningScan.status, "running");
  controller!.cancelScan();
  const cancelledScan = controller!.scan;
  assert.equal(cancelledScan.status === "failed" ? cancelledScan.issue.code : "", "cancelled");

  const connectId = controller!.connect();
  const runningConnection = controller!.connection;
  assert.equal(runningConnection.status, "running");
  wifi.completeConnect(connectId, { rssiDbm: -40, channel: 6, authKind: "wpa2" });
  const succeededConnection = controller!.connection;
  assert.equal(succeededConnection.status, "succeeded");

  // disconnect supersedes the completed connect subscription (defined branch).
  const disconnectId = controller!.disconnect();
  assert.notEqual(disconnectId, connectId);
  const runningDisconnect = controller!.connection;
  assert.equal(runningDisconnect.status, "running");

  runtime.unmount();
  // Session cleanup cancels the still-running disconnect operation.
  const finalOperation = wifi.getOperation<void>(disconnectId);
  assert.equal(finalOperation.status, "failed");

  wifi.dispose();
});

test("useWifi commands are fenced once the owning session is disposed", () => {
  const wifi = new MemoryWifiService();
  const { runtime } = createHarness({ wifi });
  let controller: WifiController | undefined;
  function App(): VNode {
    controller = useWifi();
    return <Screen><Text text="wifi" /></Screen>;
  }

  runtime.mount(<App />);
  runtime.unmount();

  controller!.connect();
  const fencedConnection = controller!.connection;
  assert.equal(fencedConnection.status, "failed");
  assert.equal(fencedConnection.status === "failed" ? fencedConnection.issue.code : "", "cancelled");

  wifi.dispose();
});

test("useWifi commands are fenced when their fiber unmounts but the session stays active", () => {
  const wifi = new MemoryWifiService();
  const { host, scheduler, runtime } = createHarness({ wifi });
  let controller: WifiController | undefined;
  function WifiPanel(): VNode {
    controller = useWifi();
    return <Text text="panel" />;
  }
  function App(): VNode {
    const [show, setShow] = useState(true);
    return (
      <Screen>
        {show ? <WifiPanel /> : <Text text="hidden" />}
        <Button label="hide" onClick={() => setShow(false)} />
      </Screen>
    );
  }

  runtime.mount(<App />);
  assert.ok(controller);
  host.click("hide");
  scheduler.flush();
  assert.equal(host.text(), "hidden");

  controller!.connect();
  const fencedConnection = controller!.connection;
  assert.equal(fencedConnection.status, "failed");
  assert.equal(fencedConnection.status === "failed" ? fencedConnection.issue.code : "", "cancelled");

  runtime.unmount();
  wifi.dispose();
});
