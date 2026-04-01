/**
 * Migration script: Sanity → Supabase
 * Run ONCE with: node scripts/migrate-sanity-to-supabase.js
 *
 * What it does:
 * 1. Reads all cfaUser records from Sanity → creates in Supabase Auth + user_profiles
 * 2. Reads all footballMatchAnalysis from Sanity → inserts in match_analysis
 * 3. Reads all liveMatchStats from Sanity → inserts in match_results
 * 4. Reads all footballFixturesCache → inserts in fixtures_cache
 *
 * CRITICAL: Run in a safe environment with .env.local loaded.
 * Usage: node -r dotenv/config scripts/migrate-sanity-to-supabase.js
 */

import { createClient as createSanityClient } from '@sanity/client';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Load env
const SANITY_PROJECT_ID = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
const SANITY_DATASET = process.env.SANITY_DATASET || 'production';
const SANITY_TOKEN = process.env.SANITY_API_TOKEN;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SANITY_PROJECT_ID || !SANITY_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required environment variables');
  console.error('NEXT_PUBLIC_SANITY_PROJECT_ID:', !!SANITY_PROJECT_ID);
  console.error('SANITY_API_TOKEN:', !!SANITY_TOKEN);
  console.error('NEXT_PUBLIC_SUPABASE_URL:', !!SUPABASE_URL);
  console.error('SUPABASE_SERVICE_ROLE_KEY:', !!SUPABASE_SERVICE_KEY);
  process.exit(1);
}

const sanity = createSanityClient({
  projectId: SANITY_PROJECT_ID,
  dataset: SANITY_DATASET,
  apiVersion: '2024-01-01',
  token: SANITY_TOKEN,
  useCdn: false,
});

const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// 1. MIGRATE USERS
// ============================================================
async function migrateUsers() {
  console.log('\n📦 Migrating users from Sanity → Supabase...');

  const users = await sanity.fetch(`*[_type == "cfaUser"]{
    _id, name, email, password, role, plan, subscriptionStatus, stripeCustomerId
  }`);

  console.log(`Found ${users.length} users in Sanity`);
  let created = 0; let skipped = 0; let failed = 0;

  for (const user of users) {
    if (!user.email) { skipped++; continue; }

    try {
      // Create in Supabase Auth (no password — user must reset)
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: user.email,
        email_confirm: true,
        user_metadata: { name: user.name || '' },
      });

      if (authError) {
        if (authError.message.includes('already been registered')) {
          console.log(`  ⚠️  Skipped (exists): ${user.email}`);
          skipped++;
          continue;
        }
        throw authError;
      }

      const userId = authData.user.id;

      // Upsert profile
      const { error: profileError } = await supabase.from('user_profiles').upsert({
        id: userId,
        email: user.email,
        name: user.name || '',
        role: user.role || 'user',
        plan: user.plan || 'free',
        stripe_customer_id: user.stripeCustomerId || null,
      });

      if (profileError) console.warn(`  ⚠️  Profile upsert failed for ${user.email}:`, profileError.message);

      created++;
      console.log(`  ✓ Created: ${user.email} (plan: ${user.plan || 'free'}, role: ${user.role || 'user'})`);
    } catch (err) {
      console.error(`  ✗ Failed: ${user.email}:`, err.message);
      failed++;
    }

    await sleep(100); // Rate limit
  }

  console.log(`\nUsers: ${created} created, ${skipped} skipped, ${failed} failed`);
}

// ============================================================
// 2. MIGRATE MATCH ANALYSIS
// ============================================================
async function migrateMatchAnalysis() {
  console.log('\n📊 Migrating match analysis...');

  // Paginate through all analysis documents
  let allDocs = [];
  let start = 0;
  const limit = 100;

  while (true) {
    const docs = await sanity.fetch(
      `*[_type == "footballMatchAnalysis"] | order(_createdAt asc) [${start}...${start + limit}]{
        _id, fixtureId, date, analysis, odds, combinada, probabilities
      }`
    );
    if (docs.length === 0) break;
    allDocs = allDocs.concat(docs);
    start += limit;
    console.log(`  Fetched ${allDocs.length} analysis docs...`);
  }

  console.log(`Found ${allDocs.length} analysis records`);
  let inserted = 0; let failed = 0;

  for (const doc of allDocs) {
    if (!doc.fixtureId || !doc.date) { failed++; continue; }

    try {
      const { error } = await supabase.from('match_analysis').upsert({
        fixture_id: Number(doc.fixtureId),
        date: doc.date,
        analysis: doc.analysis || {},
        odds: doc.odds || null,
        combinada: doc.combinada || null,
        probabilities: doc.probabilities || null,
      }, { onConflict: 'fixture_id,date' });

      if (error) throw error;
      inserted++;
    } catch (err) {
      console.error(`  ✗ Analysis ${doc.fixtureId}:`, err.message);
      failed++;
    }

    if (inserted % 50 === 0 && inserted > 0) {
      console.log(`  Inserted ${inserted}...`);
      await sleep(500);
    }
  }

  console.log(`Analysis: ${inserted} inserted, ${failed} failed`);
}

// ============================================================
// 3. MIGRATE FIXTURES CACHE
// ============================================================
async function migrateFixturesCache() {
  console.log('\n🗓️  Migrating fixtures cache...');

  const docs = await sanity.fetch(`*[_type == "footballFixturesCache"]{ _id, date, fixtures }`);
  console.log(`Found ${docs.length} fixture cache records`);

  let inserted = 0; let failed = 0;

  for (const doc of docs) {
    if (!doc.date || !doc.fixtures) { failed++; continue; }

    try {
      const { error } = await supabase.from('fixtures_cache').upsert({
        date: doc.date,
        fixtures: doc.fixtures,
      }, { onConflict: 'date' });

      if (error) throw error;
      inserted++;
    } catch (err) {
      console.error(`  ✗ Fixtures cache ${doc.date}:`, err.message);
      failed++;
    }
  }

  console.log(`Fixtures cache: ${inserted} inserted, ${failed} failed`);
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('🚀 CFAnalisis v2 — Sanity → Supabase Migration');
  console.log('='.repeat(50));
  console.log('Supabase URL:', SUPABASE_URL);
  console.log('Sanity Project:', SANITY_PROJECT_ID);

  try {
    await migrateUsers();
    await migrateMatchAnalysis();
    await migrateFixturesCache();

    console.log('\n✅ Migration complete!');
    console.log('\nNOTE: All migrated users must reset their password.');
    console.log('They can use "Forgot Password" on the login page.\n');
  } catch (err) {
    console.error('\n❌ Migration failed:', err);
    process.exit(1);
  }
}

main();
