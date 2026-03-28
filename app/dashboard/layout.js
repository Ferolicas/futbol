import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../lib/auth';
import { redirect } from 'next/navigation';
import { queryFromSanity } from '../../lib/sanity';
import ChatWidget from './chat-widget';

export const metadata = {
  title: 'Dashboard - CFanalisis',
};

export default async function DashboardLayout({ children }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect('/sign-in');

  // Fresh Sanity lookup to always get current subscription status
  const sanityUser = await queryFromSanity(
    `*[_type == "cfaUser" && _id == $id][0]{ subscriptionStatus }`,
    { id: session.user.id }
  );

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
