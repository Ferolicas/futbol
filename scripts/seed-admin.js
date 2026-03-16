/**
 * Seed admin user for CFanalisis
 * Run: node scripts/seed-admin.js
 *
 * Requires SANITY_API_TOKEN with Editor permissions in .env.local
 */

const bcrypt = require('bcryptjs');
const { createClient } = require('@sanity/client');
const fs = require('fs');
const path = require('path');

// Load .env.local
const envPath = path.join(__dirname, '..', '.env.local');
const envFile = fs.readFileSync(envPath, 'utf8');
const env = {};
envFile.split('\n').forEach(line => {
  const match = line.match(/^([^#=]+)=(.+)$/);
  if (match) env[match[1].trim()] = match[2].trim();
});

const client = createClient({
  projectId: env.NEXT_PUBLIC_SANITY_PROJECT_ID || '2fawn0zp',
  dataset: env.SANITY_DATASET || 'production',
  apiVersion: '2024-07-11',
  token: env.SANITY_API_TOKEN,
  useCdn: false,
});

async function seedAdmin() {
  console.log('Creating admin user...');

  const hashedPassword = await bcrypt.hash('Pump0517*', 12);

  await client.createOrReplace({
    _id: 'cfaUser-admin-ferney',
    _type: 'cfaUser',
    name: 'Ferney',
    email: 'ferneyolicas@gmail.com',
    password: hashedPassword,
    country: 'CO',
    plan: 'asesoria',
    role: 'admin',
    subscriptionStatus: 'active',
    stripeCustomerId: null,
    createdAt: new Date().toISOString(),
    analyzedMatches: [],
    hiddenMatches: [],
    combinadas: [],
  });

  console.log('Admin user created!');

  // Verify
  const user = await client.fetch(
    '*[_type == "cfaUser" && email == "ferneyolicas@gmail.com"][0]{ _id, name, email, role, subscriptionStatus, plan }'
  );
  console.log('Verified:', JSON.stringify(user, null, 2));
}

seedAdmin().catch(err => {
  console.error('Error:', err.message);
  if (err.message.includes('permission')) {
    console.error('\nYour SANITY_API_TOKEN is read-only. Generate a new token with Editor permissions at:');
    console.error('https://www.sanity.io/manage/project/2fawn0zp → API → Tokens → Add API Token → Editor');
  }
  process.exit(1);
});
