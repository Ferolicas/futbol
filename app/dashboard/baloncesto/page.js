import { redirect } from 'next/navigation';

export const metadata = { title: 'Baloncesto NBA y NCAA - CF Análisis' };

export default function BasketballPage() {
  redirect('/dashboard?sport=basketball');
}
