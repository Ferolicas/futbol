import { auth, currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { getOrCreateSanityUser } from '../../lib/clerk-sync';
import PlanesClient from './planes-client';

export const metadata = {
  title: 'Selecciona tu Plan - CFanalisis',
};

export default async function PlanesPage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect('/sign-in');

  const clerkUser = await currentUser();
  const sanityUser = await getOrCreateSanityUser(clerkId, clerkUser);

  // If already has active subscription, go to dashboard
  if (sanityUser && ['active', 'trialing'].includes(sanityUser.subscriptionStatus)) {
    redirect('/dashboard');
  }

  return (
    <PlanesClient
      userId={sanityUser?._id}
      email={sanityUser?.email || clerkUser?.emailAddresses?.[0]?.emailAddress}
    />
  );
}
