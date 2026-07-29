export default function DashboardBuffer({ compact = false }) {
  return (
    <div className={`dashboard-buffer ${compact ? 'is-compact' : ''}`} aria-busy="true" aria-live="polite">
      <video
        className="dashboard-buffer-logo"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-label="CF Análisis"
      >
        <source src="/logo-metalizado.webm" type="video/webm" />
      </video>
      <p>Ya casi estamos…</p>
    </div>
  );
}
