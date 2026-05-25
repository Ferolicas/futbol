/* eslint-disable */
// ─────────────────────────────────────────────────────────────────────────────
// migrate-predictions.js
//
// Migra match_predictions de Supabase al VPS Postgres usando SOLO pg (sin
// pg_dump ni psql), evitando problemas de versión entre clientes.
//
// FLUJO:
//   1. Lee columnas comunes a ambas BDs desde information_schema (excluye `id`).
//   2. Lee match_predictions de Supabase con cursor (batches de 100) → no
//      carga las miles de filas en memoria, no satura el pooler.
//   3. UPSERT en el VPS por batch: INSERT ... ON CONFLICT (fixture_id) DO NOTHING.
//      Una sola transacción por batch — si un batch falla, no deja a medias.
//   4. Imprime progreso cada batch + resumen final.
//
// USO:
//   export SUPABASE_DB="postgresql://postgres.[REF]:[PASS]@aws-0-[region].pooler.supabase.com:5432/postgres"
//   export VPS_DB="postgresql://cfanalisis:[PASS]@127.0.0.1:6432/cfanalisis"
//   node scripts/migrate-predictions.js
//
// Las cadenas también se pueden pasar como argumentos posicionales:
//   node scripts/migrate-predictions.js "$SUPABASE_DB" "$VPS_DB"
//
// Idempotente: re-correrlo solo inserta lo que aún no existe en el VPS.
// ─────────────────────────────────────────────────────────────────────────────

const { Client } = require('pg');

const TABLE = 'match_predictions';
const BATCH = 100;
const CONFLICT_COL = 'fixture_id'; // UNIQUE en la tabla — ver create-predictions-table.sql

const SUPABASE_URL = process.argv[2] || process.env.SUPABASE_DB;
const VPS_URL      = process.argv[3] || process.env.VPS_DB;

if (!SUPABASE_URL || !VPS_URL) {
  console.error('FALTAN cadenas de conexión. Define SUPABASE_DB y VPS_DB, o pásalas como argumentos.');
  process.exit(1);
}

// Helper: en Postgres los identificadores con caracteres "raros" o reservados
// deben ir entre comillas dobles, con las comillas internas escapadas.
function ident(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

async function getCommonColumns(supa, vps) {
  // Listamos columnas a copiar como la INTERSECCIÓN de ambos esquemas
  // (excluyendo `id` — es SERIAL en el VPS y debe regenerarse). Si Supabase
  // tiene columnas que el VPS no tiene, las saltamos sin error. Si el VPS
  // tiene columnas que Supabase no tiene, esas quedan en DEFAULT.
  const q = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1 AND column_name <> 'id'
    ORDER BY ordinal_position
  `;
  const [a, b] = await Promise.all([
    supa.query(q, [TABLE]),
    vps.query(q,  [TABLE]),
  ]);
  const supaCols = new Set(a.rows.map(r => r.column_name));
  const vpsCols  = new Set(b.rows.map(r => r.column_name));
  const common   = [...supaCols].filter(c => vpsCols.has(c));
  if (common.length === 0) throw new Error('No hay columnas en común entre Supabase y VPS para ' + TABLE);
  return common;
}

async function getCount(client, label) {
  const r = await client.query(`SELECT count(*)::int AS n FROM ${ident(TABLE)}`);
  return r.rows[0].n;
}

// Cursor de Supabase: usamos un DECLARE … FETCH explícito (en lugar del módulo
// pg-cursor) para no añadir dependencias. El cursor vive dentro de una
// transacción; al cerrarla con COMMIT, se libera. Streamea sin cargar todo en RAM.
async function* readBatches(supa, cols) {
  await supa.query('BEGIN');
  try {
    const colsSql = cols.map(ident).join(', ');
    // ORDER BY id para que sea reproducible entre corridas. fixture_id también
    // sirve, pero `id` está garantizado UNIQUE y monotonic en Supabase.
    await supa.query(
      `DECLARE pred_cursor NO SCROLL CURSOR FOR
       SELECT ${colsSql} FROM ${ident(TABLE)} ORDER BY id`
    );
    while (true) {
      const res = await supa.query(`FETCH ${BATCH} FROM pred_cursor`);
      if (res.rows.length === 0) break;
      yield res.rows;
    }
    await supa.query('CLOSE pred_cursor');
    await supa.query('COMMIT');
  } catch (e) {
    await supa.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

// Construye INSERT multi-row con placeholders y devuelve {sql, params}.
// Una sola query por batch = mínima latencia red.
function buildUpsert(cols, rows) {
  const colsSql = cols.map(ident).join(', ');
  const params = [];
  const valuesSql = rows.map((row, rIdx) => {
    const cells = cols.map((c, cIdx) => {
      params.push(row[c] === undefined ? null : row[c]);
      return '$' + params.length;
    });
    return '(' + cells.join(', ') + ')';
  }).join(', ');
  // RETURNING fixture_id para contar exactamente cuántas filas se insertaron
  // de las N enviadas. Las que chocaron por ON CONFLICT (ya existían) no
  // aparecen en RETURNING. Así no tenemos que diff manual.
  const sql =
    `INSERT INTO ${ident(TABLE)} (${colsSql})\n` +
    `VALUES ${valuesSql}\n` +
    `ON CONFLICT (${ident(CONFLICT_COL)}) DO NOTHING\n` +
    `RETURNING ${ident(CONFLICT_COL)}`;
  return { sql, params };
}

(async () => {
  const supa = new Client({
    connectionString: SUPABASE_URL,
    // Supabase exige SSL pero acepta cert auto-firmado del pooler.
    ssl: { rejectUnauthorized: false },
  });
  const vps = new Client({
    connectionString: VPS_URL,
    // VPS local: si DATABASE_SSL=false o conexión es 127.0.0.1, sin SSL.
    // pgBouncer del VPS típicamente sin SSL en localhost.
    ssl: process.env.DATABASE_SSL === 'false' || /127\.0\.0\.1|localhost/.test(VPS_URL)
      ? false : { rejectUnauthorized: false },
  });

  console.log('▶ Conectando a Supabase y VPS…');
  await supa.connect();
  await vps.connect();
  console.log('   conexiones OK');

  // Forzar search_path = public en AMBOS clientes:
  //   - Supabase pooler (Supavisor) puede arrancar la sesión con un
  //     search_path por defecto distinto a 'public' o con un rol/template
  //     que lo deja vacío → "relation match_predictions does not exist".
  //   - VPS: blindaje extra por si hubiera schemas legacy (auth.users etc).
  // SET search_path persiste por la vida del Client (pg.Client reusa una sola
  // conexión TCP, no la devuelve a un pool entre queries).
  await supa.query('SET search_path = public');
  await vps.query('SET search_path = public');
  // Diagnóstico explícito — si la tabla SIGUE sin resolver, el output dirá
  // exactamente cuál es current_database/current_user/schemas activos.
  const diagSupa = await supa.query(
    "SELECT current_database() AS db, current_user AS usr, current_schemas(true) AS schemas, " +
    "to_regclass('public.' || $1) AS tbl", [TABLE]);
  console.log(`   Supabase: db=${diagSupa.rows[0].db} user=${diagSupa.rows[0].usr} ` +
              `schemas=${JSON.stringify(diagSupa.rows[0].schemas)} ` +
              `tabla=${diagSupa.rows[0].tbl || 'NO ENCONTRADA'}`);
  if (!diagSupa.rows[0].tbl) {
    throw new Error(`La tabla public.${TABLE} no existe en Supabase con el rol "${diagSupa.rows[0].usr}". ` +
                    `Verifica permisos GRANT o usa otra cadena de conexión.`);
  }

  // 0) Diagnóstico
  const beforeSupa = await getCount(supa, 'Supabase');
  const beforeVps  = await getCount(vps,  'VPS');
  console.log(`   Supabase ${TABLE}: ${beforeSupa} filas`);
  console.log(`   VPS      ${TABLE}: ${beforeVps} filas (antes)`);

  // 1) Columnas a copiar (intersección de schemas)
  const cols = await getCommonColumns(supa, vps);
  console.log(`▶ Columnas comunes (${cols.length}): ${cols.join(', ')}`);

  // 2) Stream + upsert por batches
  let totalRead = 0, totalInserted = 0, totalSkipped = 0;
  let batchN = 0;
  const t0 = Date.now();

  for await (const rows of readBatches(supa, cols)) {
    batchN++;
    totalRead += rows.length;
    const { sql, params } = buildUpsert(cols, rows);
    let inserted;
    try {
      const r = await vps.query(sql, params);
      inserted = r.rowCount; // = filas que pasaron el ON CONFLICT
    } catch (e) {
      console.error(`✗ batch #${batchN} (read=${rows.length}) FALLÓ:`, e.message);
      // Estrategia: el upsert por batch es atómico (una sola query). Si falla
      // todo el batch falla, lo reportamos y abortamos para no perder
      // visibilidad del fallo. Re-correr el script reanuda donde quedó (lo
      // que SÍ se insertó queda; lo de este batch volverá a intentarse).
      throw e;
    }
    const skipped = rows.length - inserted;
    totalInserted += inserted;
    totalSkipped  += skipped;

    const pct = beforeSupa ? Math.round((totalRead / beforeSupa) * 100) : 0;
    console.log(
      `   batch #${batchN.toString().padStart(4, ' ')}  ` +
      `read=${rows.length}  ins=${inserted}  skip=${skipped}  ` +
      `total: ${totalRead}/${beforeSupa} (${pct}%)`
    );
  }

  // 3) Resumen
  const afterVps = await getCount(vps, 'VPS');
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n' + '─'.repeat(60));
  console.log(`✓ Migración completada en ${elapsedS}s`);
  console.log(`  Supabase total : ${beforeSupa}`);
  console.log(`  Leídas         : ${totalRead}`);
  console.log(`  Insertadas     : ${totalInserted}`);
  console.log(`  Saltadas (dup) : ${totalSkipped}`);
  console.log(`  VPS antes      : ${beforeVps}`);
  console.log(`  VPS ahora      : ${afterVps}  (Δ +${afterVps - beforeVps})`);
  console.log('─'.repeat(60));

  await supa.end();
  await vps.end();
})().catch(async (e) => {
  console.error('\nFATAL:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
