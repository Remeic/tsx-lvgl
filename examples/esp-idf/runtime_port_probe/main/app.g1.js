"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Pomodoro;
const jsx_runtime_1 = require("@tsx-lvgl/sdk/jsx-runtime");
const sdk_1 = require("@tsx-lvgl/sdk");
const DISPLAY_HEIGHT_PX = 448;
const WORK_MS = 25 * 60000;
const BREAK_MS = 5 * 60000;
const SHAKE_COOLDOWN_MS = 1500;
const COLORS = { elapsed: "#007d32", remaining: "#c90000" };
const styles = sdk_1.StyleSheet.create({
    screen: { backgroundColor: COLORS.elapsed, padding: 0 },
    timerField: {
        width: "100%",
        height: "100%",
        flexDirection: "column",
        justifyContent: "flex-end",
        alignItems: "center",
    },
    remainingBlock: {
        width: "100%",
    },
    clockLayer: {
        width: "100%",
        height: "100%",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
    },
    timeText: { color: "#ffffff", textAlign: "center", fontSize: 48 },
});
function Pomodoro() {
    const [phase, setPhase] = (0, sdk_1.useState)("work");
    const [deadline, setDeadline] = (0, sdk_1.useState)(() => Date.now() + WORK_MS);
    const shake = (0, sdk_1.useShake)({
        accelerationDeltaMps2: 12,
        angularVelocityDps: null,
        cooldownMs: SHAKE_COOLDOWN_MS,
    });
    const totalMs = phase === "work" ? WORK_MS : BREAK_MS;
    const remainingMs = Math.max(0, deadline - Date.now());
    const remainingPx = Math.min(DISPLAY_HEIGHT_PX, Math.max(0, Math.round((remainingMs / totalMs) * DISPLAY_HEIGHT_PX)));
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const minutesStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
    const secondsStr = seconds < 10 ? `0${seconds}` : `${seconds}`;
    const timeText = `${minutesStr}:${secondsStr}`;
    (0, sdk_1.useEffect)(() => {
        if (remainingMs > 0)
            return;
        if (phase === "work") {
            setPhase("break");
            setDeadline(Date.now() + BREAK_MS);
        }
        else {
            setPhase("work");
            setDeadline(Date.now() + WORK_MS);
        }
    }, [remainingMs, phase]);
    (0, sdk_1.useEffect)(() => {
        if (shake.count === 0)
            return;
        setDeadline(Date.now() + totalMs);
    }, [shake.count]);
    return ((0, jsx_runtime_1.jsx)(sdk_1.Screen, { style: styles.screen, children: (0, jsx_runtime_1.jsxs)(sdk_1.View, { style: styles.timerField, children: [(0, jsx_runtime_1.jsx)(sdk_1.View, { style: [
                        styles.remainingBlock,
                        {
                            height: remainingPx,
                            top: DISPLAY_HEIGHT_PX,
                            backgroundColor: COLORS.remaining,
                        },
                    ] }), (0, jsx_runtime_1.jsx)(sdk_1.View, { style: styles.clockLayer, children: (0, jsx_runtime_1.jsx)(sdk_1.Text, { text: timeText, style: styles.timeText }) })] }) }));
}
