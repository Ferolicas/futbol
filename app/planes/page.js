import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../lib/auth';
import { redirect } from 'next/navigation';
import { queryFromSanity } from '../../lib/sanity';
import PlanesClient from './planes-client';

export const metadata = {
  title: 'Selecciona tu Plan - CFanalisis',
};

export default async function PlanesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect('/sign-in');

  // Fresh Sanity lookup to always get current subscription status
  const sanityUser = await queryFromSanity(
    `*[_type == "cfaUser" && _id == $id][0]{ _id, email, subscriptionStatus }`,
    { id: session.user.id }
  );

  if (sanityUser && ['active', 'trialing'].includes(sanityUser.subscriptionStatus)) {
    redirect('/dashboard');
  }

  return (
    <PlanesClient
      userId={sanityUser?._id || session.user.id}
      email={sanityUser?.email || session.user.email}
    />
  );
}
