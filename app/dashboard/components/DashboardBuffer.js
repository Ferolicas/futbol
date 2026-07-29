import BrandLogoMedia from '../../../components/BrandLogoMedia';

export default function DashboardBuffer({ compact = false }) {
  return (
    <div className={`dashboard-buffer ${compact ? 'is-compact' : ''}`} aria-busy="true" aria-live="polite">
      <BrandLogoMedia
        className="dashboard-buffer-logo"
      />
      <p>Ya casi estamos…</p>
    </div>
  );
}
