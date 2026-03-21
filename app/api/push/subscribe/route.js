import { auth } from '@clerk/nextjs/server';
import { getSanityUserByClerkId } from '../../../../lib/clerk-sync';
import { saveToSanity, deleteFromSanity } from '../../../../lib/sanity';
import { vapidPublicKey } from '../../../../lib/webpush';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ vapidPublicKey });
}

export async function POST(request) {
  const { userId: clerkId } = await auth();
  if (!clerkId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const sanityUser = await getSanityUserByClerkId(clerkId);
  const userId = sanityUser?._id;
  if (!userId) return Response.json({ error: 'User not found' }, { status: 404 });

  const subscription = await request.json();
  const shortId = userId.replace('cfaUser-', '');

  await saveToSanity('cfaUserData', `pushsub-${shortId}`, {
    userId,
    dataType: 'pushSubscription',
    subscription: JSON.stringify(subscription),
    updatedAt: new Date().toISOString(),
  });

  return Response.json({ success: true });
}

export async function DELETE() {
  const { userId: clerkId } = await auth();
  if (!clerkId) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const sanityUser = await getSanityUserByClerkId(clerkId);
  const userId = sanityUser?._id;
  if (!userId) return Response.json({ error: 'User not found' }, { status: 404 });

  const shortId = userId.replace('cfaUser-', '');
  await deleteFromSanity('cfaUserData', `pushsub-${shortId}`);

  return Response.json({ success: true });
}
