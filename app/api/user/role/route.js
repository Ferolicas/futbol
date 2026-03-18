import { auth } from '@clerk/nextjs/server';
import { getSanityUserByClerkId } from '../../../../lib/clerk-sync';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sanityUser = await getSanityUserByClerkId(clerkId);
  return Response.json({ role: sanityUser?.role || 'user' });
}
