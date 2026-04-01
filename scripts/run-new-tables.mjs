/**
 * run-new-tables.mjs
 * Creates tickets, chat_messages, combinadas tables and
 * adds missing columns to user_profiles and push_subscriptions.
 *
 * Usage: node scripts/run-new-tables.mjs
 * Requires: SUPABASE_ACCESS_TOKEN env var (get from supabase.com/dashboard/account/tokens)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, '../.env.local');
const envVars = {};
try {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    envVars[key] = val;
  }
} catch (e) {
  console.error('Could not read .env.local:', e.message);
  process.exit(1);
}

const SUPABASE_URL = envVars.NEXT_PUBLIC_SUPABASE_URL;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN || envVars.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL');
  process.exit(1);
}

const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];
const sqlFile = resolve(__dirname, 'migrate-new-tables.sql');
const sql = readFileSync(sqlFile, 'utf-8');

if (!accessToken) {
  console.log('No SUPABASE_ACCESS_TOKEN found.');
  console.log('Get one from: https://supabase.com/dashboard/account/tokens');
  console.log('Then run:');
  console.log('  SUPABASE_ACCESS_TOKEN=your_token node scripts/run-new-tables.mjs');
  console.log('\nAlternatively, paste the SQL in the Supabase SQL Editor:');
  console.log(`  https://supabase.com/dashboard/project/${projectRef}/sql/new`);
  console.log('\nSQL file:', sqlFile);
  process.exit(1);
}

console.log(`Running migration on project: ${projectRef}\n`);

// Execute the entire SQL as a single statement via Management API
try {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    }
  );
  const body = await res.json();
  if (!res.ok) {
    console.error('Migration failed:', body.message || JSON.stringify(body));
    console.log('\nTry running the SQL manually in the Supabase SQL Editor:');
    console.log(`  https://supabase.com/dashboard/project/${projectRef}/sql/new`);
    process.exit(1);
  }
  console.log('✅ Migration complete!');
} catch (e) {
  console.error('Migration error:', e.message);
  process.exit(1);
}
