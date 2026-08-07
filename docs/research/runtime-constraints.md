# TSX-LVGL runtime constraints

**Date:** 2026-08-06  
**Scope:** primary-source constraints for the runtime-first TSX-LVGL rebuild. The repository has no existing `docs/research` convention, so this is the fallback note. It is research, not proof that on-device hot reload is implemented.

The local target is ESP-IDF 5.5, LVGL 9.5, and the Waveshare ESP32-S3-Touch-AMOLED-1.8 BSP 1.1.4. The constraints below are the boundaries the runtime and its tests must respect.

## QuickJS-NG

- A `JSRuntime` owns the JavaScript heap; a runtime does not support multithreaded access. `JSContext` objects are realms within a runtime, and `JSValue` ownership is explicit reference counting. Use one owner task/serialized executor for each runtime; do not call it concurrently from LVGL, ESP event, or ISR contexts. ([embedding guide](https://quickjs-ng.github.io/quickjs/developer-guide/intro/), [`quickjs.h`](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.h#L195-L207))
- The lifecycle is explicit: create runtime/context, release owned values and native registrations, free contexts, then free the runtime. Runtime finalizers run at the end of `JS_FreeRuntime`; they may release C resources but must not execute JavaScript. ([embedding guide](https://quickjs-ng.github.io/quickjs/developer-guide/intro/), [`quickjs.h`](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.h#L463-L495))
- A runtime can be bounded with `JS_SetMemoryLimit`, `JS_SetGCThreshold`, and `JS_SetMaxStackSize`; reference counting is deterministic, with a separate cycle-removal pass. These limits cover the JS runtime, not the complete ESP/LVGL memory budget, so both need measurement. ([runtime API](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.h#L469-L490), [internals](https://quickjs-ng.github.io/quickjs/developer-guide/internals/))
- `JS_SetInterruptHandler` is a periodic execution poll. A non-zero callback result interrupts JS, but this is not a preemptive timeout for a blocking native binding (the latter is an inference from the polling implementation). Native bindings therefore need their own bounded work and cancellation policy. ([embedding guide](https://quickjs-ng.github.io/quickjs/developer-guide/intro/), [`quickjs.c`](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.c#L8176-L8195))
- Enqueued promise/module jobs are not an automatic host event loop: the host must check and execute pending jobs. The runtime owner must therefore provide a job pump and receive timer/sensor/IO notifications through queues, not by running JS from an ISR or foreign task. ([`quickjs.h`](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.h#L1147-L1154))
- QuickJS-NG can evaluate source/modules, but its bytecode is tied to a QuickJS version and is not a trust boundary. A reload transport must authenticate/validate the bundle and pin the bytecode/runtime version if bytecode is used. ([embedding guide](https://quickjs-ng.github.io/quickjs/developer-guide/intro/))

## LVGL ownership and callback rules

- LVGL requires a tick source and periodic `lv_timer_handler`; the handler runs timers, input processing, animations, rendering, and user callbacks. LVGL is not thread-safe, including `lv_timer_handler`, so all widget-tree mutation belongs behind one LVGL gateway task or a correctly held LVGL mutex. ([integration overview](https://lvgl.io/docs/open/integration/overview))
- Timer and event callbacks run sequentially from `lv_timer_handler`. `lv_async_call`/`lv_obj_delete_async` defer work to the next handler invocation, but only the pointer is retained and it must remain valid; callers from another thread still need synchronization when scheduling. ([timer module](https://lvgl.io/docs/open/main-modules/timer), [events](https://lvgl.io/docs/open/common-widget-features/events))
- `lv_tick_inc` and `lv_display_flush_ready` are the documented cross-thread exceptions; ordinary LVGL calls are not ISR-safe. Drawing callbacks must not mutate widget attributes or the widget tree while rendering. ([integration overview](https://lvgl.io/docs/open/integration/overview), [events](https://lvgl.io/docs/open/common-widget-features/events))

## ESP-IDF tasks, events, reset, and I2C

- ESP-IDF starts `app_main` from its main task; application work should run in explicit FreeRTOS tasks. Task notifications/event queues are suitable for handing work to an owner task, and pinned-task APIs make affinity explicit when required. ([FreeRTOS integration](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-reference/system/freertos.html), [IDF FreeRTOS additions](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-reference/system/freertos_idf.html))
- ESP event loops queue and dispatch handlers in their loop context. `event_handler_arg` is not copied and must outlive every possible dispatch; handler instances should be unregistered before their bundle/context storage is freed. ISR posting is configuration-dependent and limited to 4 bytes of event data. ([event loop API](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-reference/system/esp_event.html))
- I2C transactions expose finite timeout/error results, the master bus has an explicit reset API, and a retrieved bus handle cannot be used concurrently. Serialize touch/sensor access, use bounded timeouts, and make bus reset/retry/fail-soft behavior observable. ([I2C API](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-reference/peripherals/i2c.html))
- The transient FT3168/I2C warm-reset failure is still open; see
  [the diagnosis note](../diagnostics/ft3168-i2c-reset.md) for the
  `esp_restart`/BSP source evidence and ranked hypotheses.

## Hot reload: evidence boundary

Official sources establish the primitives needed to build a reload path: evaluate a new JS program, create/free contexts and runtimes, enqueue/execute jobs, and defer LVGL deletion to its owner task. ([QuickJS-NG embedding guide](https://quickjs-ng.github.io/quickjs/developer-guide/intro/), [`quickjs.h`](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.h#L961-L962), [LVGL timer module](https://lvgl.io/docs/open/main-modules/timer)) They do **not** establish a hot-reload product contract. In particular, they do not provide atomic UI replacement, state migration, bundle transport/storage, rollback, stale-callback invalidation, or disposal of LVGL/ESP resources created by application bindings. A passing QuickJS/LVGL probe therefore proves feasibility of the primitives, not reload correctness.

The project-level reload contract must consequently be tested and implemented as an application boundary: stage and validate a bundle, enter a quiescent owner-task point, fence the old generation, unregister event/timer/sensor callbacks, dispose JS values and native resources, mutate LVGL only through its gateway, drain pending jobs, and retain the last known-good bundle until the new generation is committed. These are design requirements inferred from the [QuickJS-NG lifecycle](https://github.com/quickjs-ng/quickjs/blob/master/quickjs.h#L463-L495), [LVGL ownership rules](https://lvgl.io/docs/open/integration/overview), and [ESP event-handler lifetime](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-reference/system/esp_event.html), not vendor guarantees.

## Primary sources

- [QuickJS-NG developer guide](https://quickjs-ng.github.io/quickjs/developer-guide/intro/) and [official source](https://github.com/quickjs-ng/quickjs)
- [LVGL integration overview](https://lvgl.io/docs/open/integration/overview), [timers](https://lvgl.io/docs/open/main-modules/timer), and [events](https://lvgl.io/docs/open/common-widget-features/events)
- [ESP-IDF v5.5 FreeRTOS](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-reference/system/freertos.html), [event loop](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-reference/system/esp_event.html), [I2C](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-reference/peripherals/i2c.html), and [reset API](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32/api-reference/system/misc_system_api.html)
- [Waveshare component registry entry](https://components.espressif.com/components/waveshare/esp32_s3_touch_amoled_1_8/versions/1.1.4/readme?language=en) and [official BSP source](https://github.com/waveshareteam/Waveshare-ESP32-components/tree/c77caf968fa6b11f3b6a416c853c578d012a8cea/bsp/esp32_s3_touch_amoled_1_8)
