export default function ReportsLoading() {
  return (
    <main aria-busy="true" aria-label="Cargando informes privados" style={{ minHeight: '100vh', padding: 18, color: '#eef4f2', background: '#07100e' }}>
      <div style={{ width: 180, height: 34, borderRadius: 10, background: '#14251f' }} />
      <div style={{ width: '72%', maxWidth: 620, height: 58, marginTop: 34, borderRadius: 14, background: '#10201b' }} />
      <div style={{ width: '100%', maxWidth: 1180, height: 52, margin: '42px auto 12px', borderRadius: 16, background: '#10201b' }} />
      <div style={{ display: 'grid', width: '100%', maxWidth: 1180, margin: '0 auto', gap: 10 }}>
        {[1, 2, 3, 4].map(item => <div key={item} style={{ height: 82, borderRadius: 17, background: '#0d1a16', border: '1px solid rgba(163,231,199,.09)' }} />)}
      </div>
    </main>
  );
}
