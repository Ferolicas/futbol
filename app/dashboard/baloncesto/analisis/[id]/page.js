import MultisportAnalysisPage from '../../../components/MultisportAnalysisPage';

export const metadata = { title: 'Análisis completo de baloncesto - CF Análisis' };

export default function BasketballAnalysisPage() {
  return <MultisportAnalysisPage sport="basketball" slug="baloncesto" sportLabel="Baloncesto" scoreLabel="puntos" />;
}
