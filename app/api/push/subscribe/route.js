import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../../../lib/auth';
import { saveToSanity, deleteFromSanity } from '../../../../lib/sanity';
import { vapidPublicKey } from '../../../../lib/webpush';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ vapidPublicKey });
}

export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = session.user.id;
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
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = session.user.id;
  const shortId = userId.replace('cfaUser-', '');
  await deleteFromSanity('cfaUserData', `pushsub-${shortId}`);

  return Response.json({ success: true });
}
