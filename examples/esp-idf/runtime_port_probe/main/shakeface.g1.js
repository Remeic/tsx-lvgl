"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = ShakeFace;
const jsx_runtime_1 = require("@tsx-lvgl/sdk/jsx-runtime");
const sdk_1 = require("@tsx-lvgl/sdk");
const SHAKE_COOLDOWN_MS = 700;
function ShakeFace() {
    const [happy, setHappy] = (0, sdk_1.useState)(true);
    const [lastShakeAt, setLastShakeAt] = (0, sdk_1.useState)(-Infinity);
    const motion = (0, sdk_1.useMotion)();
    (0, sdk_1.useEffect)(() => {
        if (motion.state.status !== "ready" && motion.state.status !== "stale")
            return;
        if (!(0, sdk_1.isShake)(motion.state.value))
            return;
        if (motion.state.observedAtMs - lastShakeAt < SHAKE_COOLDOWN_MS)
            return;
        setLastShakeAt(motion.state.observedAtMs);
        setHappy((current) => !current);
    }, [motion.state]);
    const imuUnavailable = motion.state.status === "unavailable" || motion.state.status === "error" || motion.state.status === "unsupported";
    const status = imuUnavailable
        ? "IMU non disponibile"
        : happy
            ? "felice - scuotimi"
            : "triste - scuotimi";
    return ((0, jsx_runtime_1.jsx)(sdk_1.Screen, { children: (0, jsx_runtime_1.jsxs)(sdk_1.View, { children: [(0, jsx_runtime_1.jsx)(sdk_1.Text, { text: "O    O" }), (0, jsx_runtime_1.jsx)(sdk_1.Text, { text: happy ? "\\____/" : "/----\\" }), (0, jsx_runtime_1.jsx)(sdk_1.Text, { text: status }), (0, jsx_runtime_1.jsx)(sdk_1.Button, { label: happy ? "switch: sad" : "switch: happy", onClick: () => setHappy((current) => !current) })] }) }));
}
