import UnsubscribeClient from './unsubscribe-client';

export const metadata = {
  title: 'Cancelar promociones | CF Análisis',
  robots: { index: false, follow: false },
};

export default async function UnsubscribePage({ searchParams }) {
  const params = await searchParams;
  const token = typeof params?.token === 'string' ? params.token : '';
  return <UnsubscribeClient token={token} />;
}
