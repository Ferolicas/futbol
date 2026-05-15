// Skeleton del panel /ferney — respeta las cards de monitoring y la
// seccion de queues.
export default function FerneyLoading() {
  return (
    <div className="ferney-skel" aria-busy="true" aria-live="polite">
      <div className="skel-block" style={{ width: 220, height: 28, marginBottom: 24 }} />
      <div className="ferney-skel-grid">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="ferney-skel-card">
            <div className="skel-block" style={{ width: '50%', height: 14 }} />
            <div className="skel-block" style={{ width: '70%', height: 24, marginTop: 12 }} />
          </div>
        ))}
      </div>
      <div className="skel-block" style={{ width: '100%', height: 240, marginTop: 16, borderRadius: 8 }} />

      <style dangerouslySetInnerHTML={{ __html: `
        .ferney-skel { padding: 20px; }
        .ferney-skel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
        .ferney-skel-card { padding: 16px; background: #0f0f17; border: 1px solid #1c1c2a; border-radius: 12px; }
        .skel-block {
          display: inline-block;
          background: linear-gradient(90deg, #1a1a26 0%, #232336 50%, #1a1a26 100%);
          background-size: 200% 100%;
          animation: skel-shimmer 1.4s ease-in-out infinite;
          border-radius: 4px;
        }
        @keyframes skel-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      ` }} />
    </div>
  );
}
