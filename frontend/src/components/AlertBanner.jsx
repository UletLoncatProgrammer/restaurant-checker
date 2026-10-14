export default function AlertBanner({ alerts, onDismiss }) {
  if (alerts.length === 0) return null;
  return (
    <div className="alert-stack" aria-live="assertive">
      {alerts.map((a) => (
        <div key={a.id} className={`alert alert-${a.tone}`} onClick={() => onDismiss(a.id)}>
          {a.message}
        </div>
      ))}
    </div>
  );
}
