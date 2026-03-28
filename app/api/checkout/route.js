import { createEmbeddedPayment } from '../../../lib/stripe';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../../lib/auth';

export async function POST(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { plan, email, currency } = await request.json();

    if (!plan || !email) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!['plataforma', 'asesoria'].includes(plan)) {
      return Response.json({ error: 'Invalid plan' }, { status: 400 });
    }

    const sanityUser = await queryFromSanity(
      `*[_type == "cfaUser" && _id == $id][0]{ _id, name, email, password, role, stripeCustomerId }`,
      { id: session.user.id }
    );
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
      currency: currency || 'USD',
    });

    const docId = sanityUser._id.replace('cfaUser-', '');
    await saveToSanity('cfaUser', docId, {
      name: sanityUser.name,
      email: sanityUser.email,
      password: sanityUser.password,
      role: sanityUser.role,
      plan,
      subscriptionStatus: 'pending',
      stripeCustomerId: result.customerId,
      updatedAt: new Date().toISOString(),
    });

    return Response.json({
      clientSecret: result.clientSecret,
      plan: result.plan,
      amount: result.amount,
      currency: result.currency || 'usd',
    });
  } catch (error) {
    console.error('Checkout error:', error);
    return Response.json({ error: error.message || 'Checkout failed' }, { status: 500 });
  }
}
