import MultisportDashboard from '../components/MultisportDashboard';

export const metadata = { title: 'Fútbol americano NFL - CF Análisis' };

export default function AmericanFootballPage() {
  return <MultisportDashboard sport="american_football" slug="futbol-americano" title="Fútbol americano NFL" subtitle="Motor NFL independiente con resultados, contexto y cuotas verificadas." scoreLabel="puntos" accent="#f97316" />;
}
