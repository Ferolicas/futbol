import { createEmbeddedPayment } from '../../../lib/stripe';
import { saveToSanity } from '../../../lib/sanity';
import { auth } from '@clerk/nextjs/server';
import { getSanityUserByClerkId } from '../../../lib/clerk-sync';

export async function POST(request) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { plan, email } = await request.json();

    if (!plan || !email) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!['plataforma', 'asesoria'].includes(plan)) {
      return Response.json({ error: 'Invalid plan' }, { status: 400 });
    }

    const sanityUser = await getSanityUserByClerkId(clerkId);
    if (!sanityUser) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }
    if (sanityUser.email?.toLowerCase() !== email.toLowerCase().trim()) {
      return Response.json({ error: 'Email mismatch' }, { status: 403 });
    }

    const result = await createEmbeddedPayment({
      plan,
      userId: sanityUser._id,
      email: sanityUser.email,
      name: sanityUser.name,
    });

    // Update user with pending plan
    const docId = sanityUser._id.replace('cfaUser-', '');
    await saveToSanity('cfaUser', docId, {
      name: sanityUser.name,
      email: sanityUser.email,
      plan,
      subscriptionStatus: 'pending',
      stripeCustomerId: result.customerId,
      updatedAt: new Date().toISOString(),
    });

    return Response.json({
      clientSecret: result.clientSecret,
      plan: result.plan,
      amount: result.amount,
    });
  } catch (error) {
    console.error('Checkout error:', error);
    return Response.json({ error: error.message || 'Checkout failed' }, { status: 500 });
  }
}
