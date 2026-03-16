import { stripe } from '../../../lib/stripe';
import { queryFromSanity, saveToSanity } from '../../../lib/sanity';
import { sendWelcomeEmail } from '../../../lib/resend-email';

export async function POST(request) {
  if (!stripe) {
    return Response.json({ error: 'Stripe not configured' }, { status: 500 });
  }

  const body = await request.text();
  const sig = request.headers.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (webhookSecret && sig) {
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } else {
      // Dev mode: parse without signature verification
      event = JSON.parse(body);
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return Response.json({ error: 'Webhook signature failed' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, plan } = session.metadata || {};

        if (!userId) break;

        const email = session.customer_email || session.customer_details?.email;
        const customerId = session.customer;

        // Find and update user
        const user = await queryFromSanity(
          `*[_type == "cfaUser" && (_id == $userId || email == $email)][0]{ _id, name, email, password }`,
          { userId, email: email || '' }
        );

        if (user) {
          const docId = user._id.replace('cfaUser-', '');
          await saveToSanity('cfaUser', docId, {
            name: user.name,
            email: user.email,
            password: user.password,
            plan: plan || 'plataforma',
            subscriptionStatus: 'active',
            stripeCustomerId: customerId || null,
            stripeSessionId: session.id,
            paidAt: new Date().toISOString(),
          });

          // Send welcome email (don't fail if email fails)
          try {
            // We don't have the raw password, so we tell user to use the one they set
            await sendWelcomeEmail({
              to: user.email,
              name: user.name,
              plan: plan || 'plataforma',
              password: '(la contrasena que elegiste al registrarte)',
            });
          } catch (emailErr) {
            console.error('Welcome email failed:', emailErr);
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const user = await queryFromSanity(
          `*[_type == "cfaUser" && stripeCustomerId == $customerId][0]{ _id, name, email, password, plan }`,
          { customerId }
        );

        if (user) {
          const docId = user._id.replace('cfaUser-', '');
          const status = subscription.status === 'active' ? 'active'
            : subscription.status === 'trialing' ? 'trialing'
            : subscription.status === 'past_due' ? 'past_due'
            : 'inactive';

          await saveToSanity('cfaUser', docId, {
            name: user.name,
            email: user.email,
            password: user.password,
            plan: user.plan,
            subscriptionStatus: status,
            updatedAt: new Date().toISOString(),
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const user = await queryFromSanity(
          `*[_type == "cfaUser" && stripeCustomerId == $customerId][0]{ _id, name, email, password, plan }`,
          { customerId }
        );

        if (user) {
          const docId = user._id.replace('cfaUser-', '');
          await saveToSanity('cfaUser', docId, {
            name: user.name,
            email: user.email,
            password: user.password,
            plan: user.plan,
            subscriptionStatus: 'cancelled',
            cancelledAt: new Date().toISOString(),
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        const user = await queryFromSanity(
          `*[_type == "cfaUser" && stripeCustomerId == $customerId][0]{ _id, name, email, password, plan }`,
          { customerId }
        );

        if (user) {
          const docId = user._id.replace('cfaUser-', '');
          await saveToSanity('cfaUser', docId, {
            name: user.name,
            email: user.email,
            password: user.password,
            plan: user.plan,
            subscriptionStatus: 'past_due',
            updatedAt: new Date().toISOString(),
          });
        }
        break;
      }
    }
  } catch (error) {
    console.error('Webhook handler error:', error);
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 });
  }

  return Response.json({ received: true });
}
