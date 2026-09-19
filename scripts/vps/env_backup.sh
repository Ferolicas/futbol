#!/usr/bin/env bash
# Compatibility entrypoint: reuse the single completed daily holding backup.
set -euo pipefail
exec /usr/local/sbin/holding-daily-backup backup
