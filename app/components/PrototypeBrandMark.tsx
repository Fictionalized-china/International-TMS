export function PrototypeBrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`prototype-brand-mark${compact ? " compact" : ""}`}
    >
      <i />
      <i />
      <i />
    </span>
  );
}
