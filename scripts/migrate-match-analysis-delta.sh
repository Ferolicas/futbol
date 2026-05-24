#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# migrate-match-analysis-delta.sh
#
# Migra SOLO los registros de match_analysis que están en Supabase pero NO en
# el VPS, sin duplicar los existentes.
#
# Por qué staging + INSERT…SELECT…ON CONFLICT y NO pg_dump directo:
#   - pg_dump --data-only emite COPY (o INSERT planos con --inserts). NINGUNO
#     soporta ON CONFLICT. Así que cargamos el dump en una tabla STAGING (sin
#     constraints, acepta las 1473 filas) y luego insertamos en la real con
#     ON CONFLICT DO NOTHING — que ignora las que ya existen (las 404).
#   - ON CONFLICT sin target ignora CUALQUIER violación de unique/PK, así no
#     necesitamos saber el nombre exacto de la constraint.
#
# Idempotente: re-correrlo no duplica nada (las que ya están se saltan).
#
# USO:
#   1. Edita las dos connection strings de abajo (o expórtalas como env vars).
#   2. chmod +x scripts/migrate-match-analysis-delta.sh
#   3. ./scripts/migrate-match-analysis-delta.sh
#
# Requisitos: pg_dump y psql instalados en la máquina donde corres esto
#   (puede ser tu local o el propio VPS; solo necesita alcanzar ambas DBs).
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── CONFIGURACIÓN ────────────────────────────────────────────────────────────
# Supabase: Project Settings → Database → Connection string → URI (Session, 5432)
SUPABASE_DB="${SUPABASE_DB:-postgresql://postgres.[REF]:[PASSWORD]@aws-0-[region].pooler.supabase.com:5432/postgres}"

# VPS Postgres (pgBouncer). Ajusta password. Si corres ESTE script EN el VPS,
# host=127.0.0.1 está bien. Si lo corres desde tu local, usa la IP pública del
# VPS y el puerto que tengas expuesto (y SSL si aplica).
VPS_DB="${VPS_DB:-postgresql://cfanalisis:TU_PG_PASSWORD@127.0.0.1:6432/cfanalisis}"

TABLE="match_analysis"
STAGING="match_analysis_staging"
DUMP_FILE="/tmp/${TABLE}_supabase.dump.sql"

echo "▶ 1/6  Conteo ANTES en el VPS"
psql "$VPS_DB" -tAc "SELECT count(*) FROM ${TABLE};" | xargs -I{} echo "   VPS ${TABLE}: {} filas"

echo "▶ 2/6  Dump --data-only de ${TABLE} desde Supabase"
# --no-owner / --no-privileges: no traer GRANTs ni OWNER (roles de Supabase no
# existen en el VPS). Formato COPY (texto) — maneja jsonb perfecto.
pg_dump "$SUPABASE_DB" \
  --data-only --no-owner --no-privileges \
  --table="public.${TABLE}" \
  > "$DUMP_FILE"

# Quitar líneas que tocarían la tabla/secuencia REAL en vez del staging:
#   - setval de secuencias (resetearía el serial real)
# Y redirigir el COPY a la tabla staging.
sed -i \
  -e "s/COPY public\.${TABLE} /COPY ${STAGING} /" \
  -e "s/COPY ${TABLE} /COPY ${STAGING} /" \
  -e "/pg_catalog\.setval/d" \
  "$DUMP_FILE"

echo "   Dump generado: $DUMP_FILE ($(wc -l < "$DUMP_FILE") líneas)"

echo "▶ 3/6  Crear tabla staging en el VPS (misma estructura, SIN constraints)"
psql "$VPS_DB" -v ON_ERROR_STOP=1 <<SQL
DROP TABLE IF EXISTS ${STAGING};
CREATE TABLE ${STAGING} (LIKE ${TABLE});
SQL

echo "▶ 4/6  Cargar el dump en staging"
psql "$VPS_DB" -v ON_ERROR_STOP=1 -f "$DUMP_FILE"
psql "$VPS_DB" -tAc "SELECT count(*) FROM ${STAGING};" | xargs -I{} echo "   staging cargado: {} filas"

echo "▶ 5/6  INSERT en ${TABLE} con ON CONFLICT DO NOTHING (no duplica existentes)"
# SELECT * preserva el orden de columnas porque staging se creó con LIKE.
# ON CONFLICT DO NOTHING (sin target) salta cualquier fila que viole la PK/unique.
psql "$VPS_DB" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO ${TABLE}
SELECT * FROM ${STAGING}
ON CONFLICT DO NOTHING;
SQL

echo "▶ 6/6  Limpiar staging + ANALYZE + conteo final"
psql "$VPS_DB" -v ON_ERROR_STOP=1 <<SQL
DROP TABLE IF EXISTS ${STAGING};
ANALYZE ${TABLE};
SQL
psql "$VPS_DB" -tAc "SELECT count(*) FROM ${TABLE};" | xargs -I{} echo "   VPS ${TABLE} AHORA: {} filas"

rm -f "$DUMP_FILE"
echo "✓ Migración delta de ${TABLE} completada."
