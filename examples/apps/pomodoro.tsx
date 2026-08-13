import {
  Screen,
  StyleSheet,
  Text,
  View,
  useEffect,
  useShake,
  useState,
  type VNode,
} from "@tsx-lvgl/sdk";

/**
 * Pomodoro timer for a 368x448 portrait AMOLED panel.
 *
 * The display itself is the timer: green elapsed time fills the background,
 * red remaining time grows from the bottom, and the clock is painted last at
 * the display centre. A shake resets the active phase and immediately starts
 * it again. Run it with `tools/run-host`.
 */
/* Percent height on a child of a flex parent hangs the device's LVGL layout
 * during bundle commit (hardware-verified); the fill height is computed in px. */
const DISPLAY_HEIGHT_PX = 448;

const WORK_MS = 25 * 60_000;
const BREAK_MS = 5 * 60_000;
const SHAKE_COOLDOWN_MS = 1500;

const COLORS = { elapsed: "#007d32", remaining: "#c90000" } as const;

const styles = StyleSheet.create({
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

export default function Pomodoro(): VNode {
  const [phase, setPhase] = useState<"work" | "break">("work");
  const [deadline, setDeadline] = useState(() => Date.now() + WORK_MS);
  // Motion observations also repaint the clock (~12.5 Hz), so the countdown
  // needs no timer; the time math reads Date.now() below.
  const shake = useShake({
    accelerationDeltaMps2: 12,
    angularVelocityDps: null,
    cooldownMs: SHAKE_COOLDOWN_MS,
  });

  const totalMs = phase === "work" ? WORK_MS : BREAK_MS;
  const remainingMs = Math.max(0, deadline - Date.now());
  const remainingPx = Math.min(
    DISPLAY_HEIGHT_PX,
    Math.max(0, Math.round((remainingMs / totalMs) * DISPLAY_HEIGHT_PX)),
  );
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const minutesStr = minutes < 10 ? `0${minutes}` : `${minutes}`;
  const secondsStr = seconds < 10 ? `0${seconds}` : `${seconds}`;
  const timeText = `${minutesStr}:${secondsStr}`;

  // `position: absolute` and z-index are not part of the current LVGL ABI.
  // Flex lays the red block above the full-height transparent clock layer;
  // translating only the red block down restores its bottom anchor. The
  // clock layer is painted afterwards and stays centered above both colours.

  useEffect(() => {
    if (remainingMs > 0) return;
    if (phase === "work") {
      setPhase("break");
      setDeadline(Date.now() + BREAK_MS);
    } else {
      setPhase("work");
      setDeadline(Date.now() + WORK_MS);
    }
  }, [remainingMs, phase]);

  useEffect(() => {
    if (shake.count === 0) return;
    setDeadline(Date.now() + totalMs);
  }, [shake.count]);

  return (
    <Screen style={styles.screen}>
      <View style={styles.timerField}>
        <View
          style={[
            styles.remainingBlock,
            {
              height: remainingPx,
              top: DISPLAY_HEIGHT_PX,
              backgroundColor: COLORS.remaining,
            },
          ]}
        />
        <View style={styles.clockLayer}>
          <Text text={timeText} style={styles.timeText} />
        </View>
      </View>
    </Screen>
  );
}
