import { Button, Screen, StyleSheet, Text, View, useInterval, useState, type VNode } from "@tsx-lvgl/sdk";

const styles = StyleSheet.create({
  screen: { backgroundColor: "#111318" },
  column: { flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 12, width: "100%", height: "100%" },
  card: { backgroundColor: "#1e2230", borderColor: "#3a4160", borderWidth: 2, borderRadius: 12, padding: 16 },
  title: { color: "white", textAlign: "center" },
  swatchRow: { flexDirection: "row", gap: 8 },
  swatch: { width: 24, height: 24, backgroundColor: "#e0435d" },
  swatchAlt: { backgroundColor: "#4dabf7" },
  swatchAlt2: { backgroundColor: "#63e6be" },
  badge: { position: "absolute", left: 8, top: 8, backgroundColor: "#f7b731", borderRadius: 6, padding: 4 },
  box: { width: 32, height: 32, backgroundColor: "#d6409f", borderRadius: 6 },
  buttonLabel: { color: "#111318" },
});

const TICK_MS = 200;

export default function StyleGallery(): VNode {
  const [angle, setAngle] = useState(0);
  useInterval(() => setAngle((value) => (value + 15) % 360), TICK_MS);

  const opacity = 0.4 + 0.6 * Math.abs(Math.sin((angle * Math.PI) / 180));

  return (
    <Screen style={styles.screen}>
      <View style={styles.badge}>
        <Text text="NEW" style={{ color: "#111318" }} />
      </View>
      <View style={styles.column}>
        <View style={styles.card}>
          <Text text="Style Gallery" style={styles.title} />
        </View>
        <View style={styles.swatchRow}>
          <View style={styles.swatch} />
          <View style={[styles.swatch, styles.swatchAlt]} />
          <View style={[styles.swatch, styles.swatchAlt2]} />
        </View>
        <View style={[styles.box, { rotate: angle, opacity }]} />
        <Button label="tap me" onClick={() => setAngle(0)} style={styles.buttonLabel} />
      </View>
    </Screen>
  );
}
