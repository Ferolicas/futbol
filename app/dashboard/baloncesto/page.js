import MultisportDashboard from '../components/MultisportDashboard';

export const metadata = { title: 'Baloncesto NBA - CF Análisis' };

export default function BasketballPage() {
  return <MultisportDashboard sport="basketball" slug="baloncesto" title="Baloncesto NBA" subtitle="Frecuencias reales, boxscores y contexto de cada equipo." scoreLabel="puntos" accent="#38bdf8" />;
}
