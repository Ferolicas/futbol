/* eslint-disable */
// ──────────────────────────────────────────────────────────────────────────
// scripts/migrate-supabase-users-to-pg.js
//
// Copia users de Supabase Auth → tabla `users` en PG VPS.
// Conserva los UUIDs originales para que user_profiles.id siga matcheando.
// password_hash queda NULL — los users tendran que usar "olvidé contraseña"
// la primera vez que intenten login con el nuevo sistema.
//
// Run on VPS (necesita SUPABASE_SERVICE_ROLE_KEY y DATABASE_URL):
//   cd /apps/futbol
//   node --env-file=.env scripts/migrate-supabase-users-to-pg.js
//
// Idempotente: si un user ya existe en PG, se actualiza email_verified
// pero NO se sobreescribe password_hash (por si ya hicieron reset).
// ──────────────────────────────────────────────────────────────────────────

try { require('dotenv').config({ path: '.env' }); } catch {}

const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

(async () => {
  console.log('Fetching users from Supabase Auth...');
  let allUsers = [];
  let page = 1;
  const PER_PAGE = 1000;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) { console.error(error); process.exit(1); }
    allUsers = allUsers.concat(data.users || []);
    if (!data.users || data.users.length < PER_PAGE) break;
    page++;
  }
  console.log(`  → ${allUsers.length} users found in Supabase`);

  let inserted = 0, updated = 0, skipped = 0;
  for (const u of allUsers) {
    if (!u.id || !u.email) { skipped++; continue; }
    try {
      const r = await pgPool.query(
        `INSERT INTO users (id, email, password_hash, email_verified, display_name, created_at)
         VALUES ($1, $2, NULL, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           email          = EXCLUDED.email,
           email_verified = EXCLUDED.email_verified,
           display_name   = COALESCE(users.display_name, EXCLUDED.display_name)
         RETURNING (xmax = 0) AS inserted`,
        [
          u.id,
          u.email.toLowerCase(),
          !!u.email_confirmed_at,
          u.user_metadata?.display_name || u.user_metadata?.full_name || null,
          u.created_at || new Date().toISOString(),
        ],
      );
      if (r.rows[0]?.inserted) inserted++; else updated++;
    } catch (e) {
      console.error(`  ✗ ${u.email}:`, e.message);
      skipped++;
    }
  }

  console.log(`\nMigration complete:`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Updated:  ${updated}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`\n⚠ Todos los users migrados tienen password_hash = NULL.`);
  console.log(`  Deben usar "olvide mi contraseña" la primera vez.`);
  console.log(`  Para tu cuenta admin, ejecuta el password reset flow:`);
  console.log(`    curl -X POST https://cfanalisis.com/api/auth-pg/forgot-password \\`);
  console.log(`      -H "Content-Type: application/json" \\`);
  console.log(`      -d '{"email":"ferneyolicas@gmail.com"}'`);

  await pgPool.end();
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
