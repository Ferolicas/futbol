// Skeleton del dashboard de béisbol — mismo patrón shimmer que el de fútbol.
export default function BaseballLoading() {
  return (
    <div className="baseball-skel" aria-busy="true" aria-live="polite">
      <div className="baseball-skel-header">
        <div className="skel-block" style={{ width: 140, height: 26 }} />
        <div className="skel-block" style={{ width: 90, height: 26 }} />
      </div>

      <div className="baseball-skel-apuesta">
        <div className="skel-block" style={{ width: '100%', height: 56, borderRadius: 12 }} />
      </div>

      <div className="baseball-skel-list">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="baseball-skel-card">
            <div className="skel-block" style={{ width: 38, height: 38, borderRadius: '50%' }} />
            <div className="baseball-skel-cardbody">
              <div className="skel-block" style={{ width: '60%', height: 14 }} />
              <div className="skel-block" style={{ width: '40%', height: 12, marginTop: 6 }} />
            </div>
            <div className="skel-block" style={{ width: 48, height: 24, borderRadius: 6 }} />
          </div>
        ))}
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .baseball-skel { padding: 16px; }
        .baseball-skel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
        .baseball-skel-apuesta { margin-bottom: 12px; }
        .baseball-skel-list { display: flex; flex-direction: column; gap: 8px; }
        .baseball-skel-card { display: flex; align-items: center; gap: 12px; padding: 12px; background: #0f0f17; border: 1px solid #1c1c2a; border-radius: 12px; }
        .baseball-skel-cardbody { flex: 1; }
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
