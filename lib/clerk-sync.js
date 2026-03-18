import { queryFromSanity, saveToSanity } from './sanity';

/**
 * Find or create a Sanity user linked to a Clerk user.
 * 1. Try to find by clerkId
 * 2. Try to match by email (migration from NextAuth)
 * 3. Create new user
 */
export async function getOrCreateSanityUser(clerkId, clerkUser) {
  if (!clerkId) return null;

  const fields = '_id, name, email, role, plan, subscriptionStatus, stripeCustomerId, clerkId';

  // 1. Find by clerkId
  let user = await queryFromSanity(
    `*[_type == "cfaUser" && clerkId == $clerkId][0]{ ${fields} }`,
    { clerkId }
  );
  if (user) return user;

  // 2. Try to match by email (migration from NextAuth accounts)
  const email = clerkUser?.emailAddresses?.[0]?.emailAddress?.toLowerCase();
  if (email) {
    user = await queryFromSanity(
      `*[_type == "cfaUser" && email == $email][0]{ ${fields} }`,
      { email }
    );
    if (user) {
      // Link existing Sanity user to Clerk
      const docId = user._id.replace('cfaUser-', '');
      await saveToSanity('cfaUser', docId, {
        name: user.name,
        email: user.email,
        role: user.role,
        plan: user.plan,
        subscriptionStatus: user.subscriptionStatus,
        stripeCustomerId: user.stripeCustomerId,
        clerkId,
        updatedAt: new Date().toISOString(),
      });
      return { ...user, clerkId };
    }
  }

  // 3. Create new Sanity user
  const name = clerkUser?.firstName
    ? `${clerkUser.firstName} ${clerkUser.lastName || ''}`.trim()
    : email?.split('@')[0] || 'Usuario';

  const docId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await saveToSanity('cfaUser', docId, {
    name,
    email: email || '',
    clerkId,
    role: 'user',
    plan: null,
    subscriptionStatus: 'pending',
    createdAt: new Date().toISOString(),
    analyzedMatches: [],
    hiddenMatches: [],
    combinadas: [],
  });

  return {
    _id: `cfaUser-${docId}`,
    name,
    email,
    clerkId,
    role: 'user',
    plan: null,
    subscriptionStatus: 'pending',
  };
}

/**
 * Get Sanity user by Clerk ID (without creating).
 */
export async function getSanityUserByClerkId(clerkId) {
  if (!clerkId) return null;
  return queryFromSanity(
    `*[_type == "cfaUser" && clerkId == $clerkId][0]{
      _id, name, email, role, plan, subscriptionStatus, stripeCustomerId, clerkId
    }`,
    { clerkId }
  );
}
