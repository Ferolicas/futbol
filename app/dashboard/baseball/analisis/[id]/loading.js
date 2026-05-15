// Skeleton del análisis individual de baseball — replica el layout real
// (header + score box + secciones de Moneyline/Totals/RunLine/F5 etc).
export default function BaseballAnalysisLoading() {
  return (
    <div className="bb-analisis-skel" aria-busy="true" aria-live="polite">
      <div className="skel-block" style={{ width: 90, height: 32, marginBottom: 16 }} />

      <div className="bb-skel-header">
        <div className="bb-skel-team">
          <div className="skel-block" style={{ width: 40, height: 12, marginBottom: 6 }} />
          <div className="skel-block" style={{ width: 160, height: 22 }} />
        </div>
        <div className="skel-block" style={{ width: 26, height: 22 }} />
        <div className="bb-skel-team">
          <div className="skel-block" style={{ width: 40, height: 12, marginBottom: 6 }} />
          <div className="skel-block" style={{ width: 160, height: 22 }} />
        </div>
      </div>

      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="bb-skel-section">
          <div className="skel-block" style={{ width: '40%', height: 18, marginBottom: 12 }} />
          <div className="skel-block" style={{ width: '100%', height: 60, borderRadius: 8 }} />
        </div>
      ))}

      <style dangerouslySetInnerHTML={{ __html: `
        .bb-analisis-skel { padding: 20px; max-width: 1100px; margin: 0 auto; color: #e2e8f0; }
        .bb-skel-header {
          background: rgba(245,158,11,0.05); border: 1px solid rgba(245,158,11,0.18);
          border-radius: 14px; padding: 18px; margin-bottom: 16px;
          display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
        }
        .bb-skel-team { flex: 1; min-width: 0; }
        .bb-skel-section {
          background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
          border-radius: 14px; padding: 16px; margin-bottom: 14px;
        }
        .skel-block {
          display: inline-block;
          background: linear-gradient(90deg, rgba(245,158,11,0.08) 0%, rgba(245,158,11,0.18) 50%, rgba(245,158,11,0.08) 100%);
          background-size: 200% 100%;
          animation: bb-skel-shimmer 1.4s ease-in-out infinite;
          border-radius: 4px;
        }
        @keyframes bb-skel-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      ` }} />
    </div>
  );
}
