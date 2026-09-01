import { redirect } from 'next/navigation';

export const metadata = { title: 'Fútbol americano NFL y NCAA - CF Análisis' };

export default function AmericanFootballPage() {
  redirect('/dashboard?sport=american_football');
}
