#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# migrate-match-predictions-delta.sh
#
# Migra todos los registros de match_predictions de Supabase al PG del VPS
# usando UPSERT con fixture_id como clave de deduplicación. Solo entran las
# filas que NO existen ya en el VPS — los duplicados se descartan.
#
# Patrón staging + INSERT…SELECT…ON CONFLICT (igual que
# migrate-match-analysis-delta.sh) — pg_dump no admite ON CONFLICT.
# ON CONFLICT (fixture_id) DO NOTHING aprovecha el UNIQUE en fixture_id
# que tiene la tabla (ver scripts/create-predictions-table.sql).
#
# Idempotente: re-correrlo no duplica nada.
#
# USO (en el VPS o en local con acceso a ambas DBs):
#   export SUPABASE_DB="postgresql://postgres.[REF]:[PASS]@aws-0-[region].pooler.supabase.com:5432/postgres"
#   export VPS_DB="postgresql://cfanalisis:[PASS]@127.0.0.1:6432/cfanalisis"
#   chmod +x scripts/migrate-match-predictions-delta.sh
#   ./scripts/migrate-match-predictions-delta.sh
#
# Requisitos: pg_dump y psql (mismo major version que el server o más reciente)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SUPABASE_DB="${SUPABASE_DB:-postgresql://postgres.[REF]:[PASSWORD]@aws-0-[region].pooler.supabase.com:5432/postgres}"
VPS_DB="${VPS_DB:-postgresql://cfanalisis:TU_PG_PASSWORD@127.0.0.1:6432/cfanalisis}"

TABLE="match_predictions"
STAGING="match_predictions_staging"
DUMP_FILE="/tmp/${TABLE}_supabase.dump.sql"

echo "▶ 1/7  Conteo ANTES en VPS y SUPABASE"
VPS_BEFORE=$(psql "$VPS_DB" -tAc "SELECT count(*) FROM ${TABLE};")
SUPA_TOTAL=$(psql "$SUPABASE_DB" -tAc "SELECT count(*) FROM ${TABLE};")
echo "   VPS ${TABLE}: $VPS_BEFORE filas"
echo "   Supabase ${TABLE}: $SUPA_TOTAL filas"

echo "▶ 2/7  Dump --data-only de ${TABLE} desde Supabase"
pg_dump "$SUPABASE_DB" \
  --data-only --no-owner --no-privileges \
  --table="public.${TABLE}" \
  > "$DUMP_FILE"

# Quitar setval de secuencias (resetearía el SERIAL del VPS) y redirigir COPY
# a la tabla staging — NO a la tabla real.
sed -i \
  -e "s/COPY public\.${TABLE} /COPY ${STAGING} /" \
  -e "s/COPY ${TABLE} /COPY ${STAGING} /" \
  -e "/pg_catalog\.setval/d" \
  "$DUMP_FILE"
echo "   Dump generado: $DUMP_FILE ($(wc -l < "$DUMP_FILE") líneas)"

echo "▶ 3/7  Crear staging en el VPS (misma estructura, SIN constraints/PK)"
psql "$VPS_DB" -v ON_ERROR_STOP=1 <<SQL
DROP TABLE IF EXISTS ${STAGING};
CREATE TABLE ${STAGING} (LIKE ${TABLE});
-- LIKE sin INCLUDING DEFAULTS evita que la columna `id SERIAL` reclame valores
-- del seq del VPS; el COPY trae los IDs de Supabase y los descartamos al
-- hacer el INSERT (no copiamos `id`, dejamos que el VPS asigne uno nuevo).
SQL

echo "▶ 4/7  Cargar dump en staging"
psql "$VPS_DB" -v ON_ERROR_STOP=1 -f "$DUMP_FILE"
STAGING_N=$(psql "$VPS_DB" -tAc "SELECT count(*) FROM ${STAGING};")
echo "   staging cargado: $STAGING_N filas"

echo "▶ 5/7  Listar columnas comunes (excluyendo 'id') para INSERT…SELECT"
# Construimos la lista de columnas dinámicamente para que el script siga
# funcionando si en el futuro se añaden columnas a la tabla. Excluimos `id`
# porque es SERIAL y el VPS le asigna uno propio.
COLS=$(psql "$VPS_DB" -tAc "
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='${TABLE}' AND column_name <> 'id';
")
if [ -z "$COLS" ]; then echo "ERROR: no se pudieron leer las columnas de ${TABLE}"; exit 1; fi
echo "   columnas a copiar: $COLS"

echo "▶ 6/7  UPSERT en ${TABLE} con ON CONFLICT (fixture_id) DO NOTHING"
# fixture_id es BIGINT UNIQUE en la tabla → ON CONFLICT (fixture_id) deduplica.
# DO NOTHING preserva las filas existentes del VPS (no las sobrescribe);
# si quisieras pisar lo viejo, cambia a DO UPDATE SET col = EXCLUDED.col.
# Aquí dejamos DO NOTHING porque las predicciones son inmutables una vez
# generadas (snapshot del momento del pick) — sobrescribir no aporta.
INSERTED=$(psql "$VPS_DB" -v ON_ERROR_STOP=1 -tAc "
  WITH ins AS (
    INSERT INTO ${TABLE} ($COLS)
    SELECT $COLS FROM ${STAGING}
    ON CONFLICT (fixture_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) FROM ins;
")
SKIPPED=$((STAGING_N - INSERTED))
echo "   insertadas: $INSERTED   ya existían (skip): $SKIPPED"

echo "▶ 7/7  Limpiar staging + ANALYZE + conteo final"
psql "$VPS_DB" -v ON_ERROR_STOP=1 <<SQL
DROP TABLE IF EXISTS ${STAGING};
ANALYZE ${TABLE};
SQL
VPS_AFTER=$(psql "$VPS_DB" -tAc "SELECT count(*) FROM ${TABLE};")
echo "   VPS ${TABLE} AHORA: $VPS_AFTER filas (antes $VPS_BEFORE, +$((VPS_AFTER - VPS_BEFORE)))"

rm -f "$DUMP_FILE"
echo ""
echo "✓ Migración delta ${TABLE} completada."
echo "  Supabase total : $SUPA_TOTAL"
echo "  VPS antes      : $VPS_BEFORE"
echo "  Insertadas     : $INSERTED"
echo "  Saltadas (dup) : $SKIPPED"
echo "  VPS ahora      : $VPS_AFTER"
