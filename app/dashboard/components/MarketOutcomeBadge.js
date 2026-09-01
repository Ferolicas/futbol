export default function MarketOutcomeBadge({ outcome, pendingLabel = null, compact = false }) {
  const status = outcome?.status;
  if (!['won', 'lost'].includes(status)) {
    const neutralLabel = status === 'void' ? 'Nula' : pendingLabel;
    return neutralLabel ? (
      <span className={`market-outcome-badge is-pending${compact ? ' is-compact' : ''}`}>
        <i aria-hidden="true" />
        <strong>{neutralLabel}</strong>
      </span>
    ) : null;
  }

  const won = status === 'won';
  return (
    <span className={`market-outcome-badge ${won ? 'is-won' : 'is-lost'}${compact ? ' is-compact' : ''}`}>
      <img
        src={won ? '/daily-pick-sticker.webp' : '/daily-pick-lost-sticker.webp'}
        alt=""
        width="28"
        height="28"
        aria-hidden="true"
      />
      <strong>{won ? 'Ganada' : 'Perdida'}</strong>
    </span>
  );
}
