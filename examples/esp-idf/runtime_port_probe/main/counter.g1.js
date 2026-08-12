"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Counter;
const jsx_runtime_1 = require("@tsx-lvgl/sdk/jsx-runtime");
const sdk_1 = require("@tsx-lvgl/sdk");
function Counter() {
    const [count, setCount] = (0, sdk_1.useState)(0);
    const motion = (0, sdk_1.useMotion)();
    const motionText = motion.state.status === "ready" || motion.state.status === "stale"
        ? `motion=${(0, sdk_1.isShake)(motion.state.value) ? "SHAKE" : "STILL"}`
        : `motion=${motion.state.status}`;
    return ((0, jsx_runtime_1.jsxs)(sdk_1.Screen, { children: [(0, jsx_runtime_1.jsx)(sdk_1.Text, { text: `count=${count}` }), (0, jsx_runtime_1.jsx)(sdk_1.Text, { text: motionText }), (0, jsx_runtime_1.jsx)(sdk_1.Button, { label: "increment", onClick: () => setCount((value) => value + 1) })] }));
}
