// Spice choice and note shown under a dish name (order entry, kitchen screens, POS).
export default function LineExtras({ item }) {
  if (!item.spice && !item.notes) return null;
  return (
    <em style={{ display: "block", fontSize: "0.8rem" }}>
      {item.spice === "SPICY" && <span className="spice-tag spicy">Spicy</span>}
      {item.spice === "NOT_SPICY" && <span className="spice-tag">Not spicy</span>}
      {item.notes}
    </em>
  );
}
