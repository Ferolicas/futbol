import MultisportDashboard from '../components/MultisportDashboard';

export const metadata = { title: 'Baloncesto NBA y NCAA - CF Análisis' };

export default function BasketballPage() {
  return <MultisportDashboard sport="basketball" slug="baloncesto" title="baloncesto" scoreLabel="puntos" />;
}
