"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = ShakeFace;
const jsx_runtime_1 = require("@tsx-lvgl/core/jsx-runtime");
const core_1 = require("@tsx-lvgl/core");
const runtime_1 = require("@tsx-lvgl/runtime");
const sensors_1 = require("@tsx-lvgl/sensors");
const SHAKE_COOLDOWN_MS = 700;
function ShakeFace() {
    const [happy, setHappy] = (0, runtime_1.useState)(true);
    const [lastShakeAt, setLastShakeAt] = (0, runtime_1.useState)(-Infinity);
    const sample = (0, runtime_1.useSensor)(sensors_1.motionSchema);
    (0, runtime_1.useEffect)(() => {
        if (sample === undefined)
            return;
        if (sample.status !== "ok" || sample.value === undefined)
            return;
        if (!(0, sensors_1.isShake)(sample.value))
            return;
        if (sample.sampledAtMs - lastShakeAt < SHAKE_COOLDOWN_MS)
            return;
        setLastShakeAt(sample.sampledAtMs);
        setHappy((current) => !current);
    }, [sample]);
    const imuUnavailable = sample !== undefined && sample.status !== "ok";
    const status = imuUnavailable
        ? "IMU non disponibile"
        : happy
            ? "felice - scuotimi"
            : "triste - scuotimi";
    return ((0, jsx_runtime_1.jsx)(core_1.Screen, { children: (0, jsx_runtime_1.jsxs)(core_1.View, { children: [(0, jsx_runtime_1.jsx)(core_1.Text, { text: "O    O" }), (0, jsx_runtime_1.jsx)(core_1.Text, { text: happy ? "\\____/" : "/----\\" }), (0, jsx_runtime_1.jsx)(core_1.Text, { text: status }), (0, jsx_runtime_1.jsx)(core_1.Button, { label: happy ? "switch: sad" : "switch: happy", onClick: () => setHappy((current) => !current) })] }) }));
}
