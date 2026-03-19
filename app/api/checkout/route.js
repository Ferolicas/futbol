import { createCheckoutSession } from '../../../lib/stripe';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';
import { auth } from '@clerk/nextjs/server';
import { getSanityUserByClerkId } from '../../../lib/clerk-sync';

export async function POST(request) {
  try {
    // Validate Clerk session first
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { plan, userId, email, localCurrency, exchangeRate } = await request.json();

    if (!plan || !email) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!['plataforma', 'asesoria'].includes(plan)) {
      return Response.json({ error: 'Invalid plan' }, { status: 400 });
    }

    // Validate: email from body must match the authenticated user's email
    const sanityUser = await getSanityUserByClerkId(clerkId);
    if (!sanityUser) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }
    if (sanityUser.email?.toLowerCase() !== email.toLowerCase().trim()) {
      return Response.json({ error: 'Email mismatch' }, { status: 403 });
    }

    // Use the validated Sanity user — never trust client-provided userId
    const user = sanityUser;

    if (!user) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    const session = await createCheckoutSession({
      plan,
      userId: user._id,
      email: user.email,
      name: user.name,
      localCurrency,
      exchangeRate,
    });

    // Update user with pending plan
    const docId = user._id.replace('cfaUser-', '');
    await saveToSanity('cfaUser', docId, {
      name: user.name,
      email: user.email,
      plan,
      subscriptionStatus: 'pending',
      updatedAt: new Date().toISOString(),
    });

    return Response.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Checkout error:', error);
    return Response.json({ error: error.message || 'Checkout failed' }, { status: 500 });
  }
}
