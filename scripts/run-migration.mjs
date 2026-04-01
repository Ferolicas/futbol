/**
 * run-migration.mjs
 * Executes supabase-schema.sql against the live Supabase project
 * using the Management API (requires SUPABASE_ACCESS_TOKEN env var).
 *
 * Usage: node scripts/run-migration.mjs
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read .env.local manually (no dotenv needed — we parse it ourselves)
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
const SERVICE_KEY = envVars.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

// Project ref from URL: https://{ref}.supabase.co
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];
console.log(`Project ref: ${projectRef}`);

// Read the SQL schema file
const sqlPath = resolve(__dirname, 'supabase-schema.sql');
const sql = readFileSync(sqlPath, 'utf-8');

// Split into individual statements (split on semicolons followed by newline/end)
// but preserve function bodies which contain semicolons
const statements = splitSqlStatements(sql);
console.log(`Parsed ${statements.length} SQL statements\n`);

// Use the Supabase Management API to run the SQL
// Endpoint: POST https://api.supabase.com/v1/projects/{ref}/database/query
// Auth: Bearer {access_token} — but we don't have a personal access token here.
//
// Alternative: use supabase-js with service_role to call a helper function.
// Since we can't run raw DDL via supabase-js, we use the pg connection.
//
// Supabase exposes PostgreSQL directly at:
//   postgres://postgres:[DB_PASSWORD]@db.[REF].supabase.co:5432/postgres
//
// We'll try connecting via the Supabase REST API's sql execution endpoint
// which is available at /rest/v1/rpc/exec_sql if the function exists.

// Build the admin client for verification queries
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Try to verify which tables already exist
const tablesToCheck = [
  'user_profiles', 'user_favorites', 'user_hidden',
  'push_subscriptions', 'match_results', 'match_analysis',
  'fixtures_cache', 'app_config', 'match_schedule'
];

console.log('Checking existing tables...');
const existingTables = [];
for (const table of tablesToCheck) {
  const { error } = await supabase.from(table).select('*').limit(1);
  if (!error || error.code === 'PGRST116') {
    existingTables.push(table);
    console.log(`  ✓ ${table} — exists`);
  } else {
    console.log(`  ✗ ${table} — missing (${error.code})`);
  }
}

if (existingTables.length === tablesToCheck.length) {
  console.log('\n✅ All tables already exist. Schema is up to date.');
  process.exit(0);
}

const missing = tablesToCheck.filter(t => !existingTables.includes(t));
console.log(`\n⚠️  Missing tables: ${missing.join(', ')}`);
console.log('\nTo create them, run the SQL in the Supabase dashboard:');
console.log(`  https://supabase.com/dashboard/project/${projectRef}/sql/new`);
console.log('\nCopying schema SQL path for reference:');
console.log(`  ${sqlPath}`);
console.log('\nAttempting to run via Supabase Management API...');

// Try Management API (requires SUPABASE_ACCESS_TOKEN — set this if you have it)
const accessToken = process.env.SUPABASE_ACCESS_TOKEN || envVars.SUPABASE_ACCESS_TOKEN;
if (!accessToken) {
  console.log('\n⚠️  No SUPABASE_ACCESS_TOKEN found.');
  console.log('Get one from: https://supabase.com/dashboard/account/tokens');
  console.log('Then run: SUPABASE_ACCESS_TOKEN=your_token node scripts/run-migration.mjs');

  // Fall back: write a combined SQL file that can be pasted easily
  const outputPath = resolve(__dirname, 'schema-ready.sql');
  const readySql = statements.filter(s => s.trim()).join('\n\n') + '\n';
  const { writeFileSync } = await import('fs');
  writeFileSync(outputPath, readySql, 'utf-8');
  console.log(`\nSQL written to: ${outputPath}`);
  process.exit(1);
}

// Execute via Management API
let success = 0;
let failed = 0;

for (const stmt of statements) {
  if (!stmt.trim()) continue;
  const preview = stmt.trim().split('\n')[0].slice(0, 60);
  try {
    const res = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: stmt }),
      }
    );
    const body = await res.json();
    if (!res.ok) {
      const msg = body.message || body.error || JSON.stringify(body);
      // Ignore "already exists" errors
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        console.log(`  ~ ${preview}... (already exists)`);
        success++;
      } else {
        console.error(`  ✗ ${preview}...\n    Error: ${msg}`);
        failed++;
      }
    } else {
      console.log(`  ✓ ${preview}...`);
      success++;
    }
  } catch (e) {
    console.error(`  ✗ ${preview}...\n    Error: ${e.message}`);
    failed++;
  }
}

console.log(`\n${success} statements executed, ${failed} failed.`);
if (failed === 0) {
  console.log('✅ Schema migration complete!');
} else {
  console.log('⚠️  Some statements failed. Check errors above.');
  process.exit(1);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inDollarQuote = false;
  let dollarTag = '';

  const lines = sql.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip pure comment lines and blank lines at the top level
    if (!inDollarQuote && (trimmed.startsWith('--') || trimmed === '')) {
      continue;
    }

    current += line + '\n';

    // Detect $$ dollar quoting (PL/pgSQL function bodies)
    const dollarMatches = line.match(/\$\$|\$[a-zA-Z_][a-zA-Z0-9_]*\$/g) || [];
    for (const match of dollarMatches) {
      if (!inDollarQuote) {
        inDollarQuote = true;
        dollarTag = match;
      } else if (match === dollarTag) {
        inDollarQuote = false;
        dollarTag = '';
      }
    }

    // Only split on semicolons at the top level (not inside function bodies)
    if (!inDollarQuote && trimmed.endsWith(';')) {
      const stmt = current.trim();
      if (stmt && stmt !== ';') {
        statements.push(stmt);
      }
      current = '';
    }
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}
