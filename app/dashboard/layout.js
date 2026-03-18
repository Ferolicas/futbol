import { auth, currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { getOrCreateSanityUser } from '../../lib/clerk-sync';
import ChatWidget from './chat-widget';

export const metadata = {
  title: 'Dashboard - CFanalisis',
};

export default async function DashboardLayout({ children }) {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');

  const clerkUser = await currentUser();
  const sanityUser = await getOrCreateSanityUser(clerkId, clerkUser);

  // Payment gate: no active subscription → redirect to plan selection
  if (!sanityUser || !['active', 'trialing'].includes(sanityUser.subscriptionStatus)) {
    redirect('/planes');
  }

  return (
    <>
      {children}
      <ChatWidget />
    </>
  );
}
