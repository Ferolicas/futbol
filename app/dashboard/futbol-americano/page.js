import MultisportDashboard from '../components/MultisportDashboard';

export const metadata = { title: 'Fútbol americano NFL y NCAA - CF Análisis' };

export default function AmericanFootballPage() {
  return <MultisportDashboard sport="american_football" slug="futbol-americano" title="fútbol americano" scoreLabel="puntos" />;
}
