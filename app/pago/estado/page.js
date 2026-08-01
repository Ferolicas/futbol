import { redirect } from 'next/navigation';
import { getCurrentUser } from '../../../lib/auth-pg';
import PaymentStatusClient from './payment-status-client';

export const metadata = { title: 'Estado del pago - CF Analisis' };

export default async function PaymentStatusPage({ searchParams }) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  const attemptId = typeof searchParams?.attempt === 'string' ? searchParams.attempt : '';
  if (!attemptId) redirect('/planes');
  return <PaymentStatusClient attemptId={attemptId} />;
}
