#!/usr/bin/env bash
# ============================================================================
# restore.sh — Restaurar la base cfanalisis desde un backup .dump
#
# USO:
#   ./restore.sh latest                       # descarga el mas reciente de B2
#   ./restore.sh backup_cfanalisis_2026-05-14_03.dump   # archivo concreto
#   ./restore.sh /apps/backup/backup_xxx.dump            # archivo local
#
# ATENCION:
#   Este script SOBREESCRIBE la base de datos actual (--clean --if-exists).
#   Usa --dry-run para verificar antes de aplicarlo.
#
# Variables de entorno (en /apps/backup/.env):
#   PGUSER, PGPASSWORD, PGDATABASE, PGHOST, PGPORT
#   RCLONE_REMOTE
# ============================================================================

set -euo pipefail

BACKUP_DIR="/apps/backup"
ENV_FILE="${BACKUP_DIR}/.env"

if [ -f "${ENV_FILE}" ]; then
  set -a; source "${ENV_FILE}"; set +a
fi

PGUSER="${PGUSER:-cfanalisis}"
PGDATABASE="${PGDATABASE:-cfanalisis}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"

DRY_RUN=0
TARGET=""

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    *) TARGET="${arg}" ;;
  esac
done

if [ -z "${TARGET}" ]; then
  echo "USO: $0 <latest|nombre.dump|/ruta/local.dump> [--dry-run]"
  exit 2
fi

# ── 1. Resolver fuente ──────────────────────────────────────────────────────
DUMP_FILE=""

if [ -f "${TARGET}" ]; then
  DUMP_FILE="${TARGET}"
  echo "→ usando archivo local: ${DUMP_FILE}"
elif [ "${TARGET}" = "latest" ]; then
  if [ -z "${RCLONE_REMOTE:-}" ]; then
    echo "ERROR: RCLONE_REMOTE no configurado"; exit 1
  fi
  LATEST="$(rclone lsf "${RCLONE_REMOTE}/" --include 'backup_cfanalisis_*.dump' \
            | sort | tail -n 1)"
  if [ -z "${LATEST}" ]; then
    echo "ERROR: no hay backups en ${RCLONE_REMOTE}"; exit 1
  fi
  DUMP_FILE="${BACKUP_DIR}/${LATEST}"
  echo "→ descargando ${LATEST} de ${RCLONE_REMOTE}..."
  rclone copy "${RCLONE_REMOTE}/${LATEST}" "${BACKUP_DIR}/"
else
  # Archivo en B2 por nombre
  if [ -z "${RCLONE_REMOTE:-}" ]; then
    echo "ERROR: RCLONE_REMOTE no configurado"; exit 1
  fi
  DUMP_FILE="${BACKUP_DIR}/${TARGET}"
  echo "→ descargando ${TARGET} de ${RCLONE_REMOTE}..."
  rclone copy "${RCLONE_REMOTE}/${TARGET}" "${BACKUP_DIR}/"
fi

if [ ! -f "${DUMP_FILE}" ]; then
  echo "ERROR: archivo no existe: ${DUMP_FILE}"; exit 1
fi

echo "→ archivo: ${DUMP_FILE} ($(du -h "${DUMP_FILE}" | cut -f1))"
echo "→ destino: ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"

# ── 2. pg_restore ───────────────────────────────────────────────────────────
COMMON_FLAGS=(
  -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}"
  -d "${PGDATABASE}"
  --clean --if-exists --no-owner --no-privileges
  -j 2
)

if [ "${DRY_RUN}" = "1" ]; then
  echo "→ DRY RUN: contenido del dump:"
  pg_restore --list "${DUMP_FILE}" | head -30
  echo "..."
  echo "(usa el mismo comando sin --dry-run para aplicar)"
  exit 0
fi

read -r -p "⚠ Esto SOBREESCRIBE ${PGDATABASE}. Confirmar [yes/no]: " CONFIRM
if [ "${CONFIRM}" != "yes" ]; then
  echo "abortado"; exit 0
fi

echo "→ restaurando..."
PGPASSWORD="${PGPASSWORD:-}" pg_restore "${COMMON_FLAGS[@]}" "${DUMP_FILE}"

echo "DONE."
