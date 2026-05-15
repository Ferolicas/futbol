// Skeleton del detalle de partido — respeta el header con escudos +
// secciones de probabilidades + combinada que muestra la pagina real.
export default function AnalisisLoading() {
  return (
    <div className="analisis-skel" aria-busy="true" aria-live="polite">
      <div className="analisis-skel-head">
        <div className="skel-block" style={{ width: 80, height: 80, borderRadius: '50%' }} />
        <div className="analisis-skel-vs">
          <div className="skel-block" style={{ width: 70, height: 14 }} />
          <div className="skel-block" style={{ width: 60, height: 22, marginTop: 8 }} />
        </div>
        <div className="skel-block" style={{ width: 80, height: 80, borderRadius: '50%' }} />
      </div>

      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="analisis-skel-section">
          <div className="skel-block" style={{ width: '40%', height: 18, marginBottom: 12 }} />
          <div className="skel-block" style={{ width: '100%', height: 80, borderRadius: 8 }} />
        </div>
      ))}

      <style dangerouslySetInnerHTML={{ __html: `
        .analisis-skel { padding: 20px; max-width: 720px; margin: 0 auto; }
        .analisis-skel-head { display: flex; align-items: center; justify-content: space-around; margin-bottom: 24px; }
        .analisis-skel-vs { display: flex; flex-direction: column; align-items: center; }
        .analisis-skel-section { margin-bottom: 16px; padding: 12px; background: #0f0f17; border: 1px solid #1c1c2a; border-radius: 12px; }
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
