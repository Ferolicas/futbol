#!/usr/bin/env bash
# Instala observabilidad nativa (sin Docker) y mantiene todas las interfaces
# administrativas en loopback. Ejecutar como root desde /apps/futbol.
set -euo pipefail
umask 077

if [ "$(id -u)" -ne 0 ]; then
  echo 'Debe ejecutarse como root' >&2
  exit 1
fi

REPO_DIR="$(git rev-parse --show-toplevel)"
OBS_DIR="${REPO_DIR}/ops/observability"
WORKER_ENV="${REPO_DIR}/apps/cfanalisis-worker/.env"
HEALTH_ENV=/apps/scripts/health.env

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  apt-transport-https wget gnupg \
  prometheus prometheus-alertmanager prometheus-node-exporter \
  prometheus-postgres-exporter prometheus-redis-exporter \
  prometheus-blackbox-exporter

install -d -m 0755 /etc/apt/keyrings
wget -qO /etc/apt/keyrings/grafana.asc https://apt.grafana.com/gpg-full.key
chmod 0644 /etc/apt/keyrings/grafana.asc
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/grafana.asc] https://apt.grafana.com stable main' \
  > /etc/apt/sources.list.d/grafana.list
apt-get update
GRAFANA_VERSION="${GRAFANA_VERSION:-12.4.10}"
DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "grafana=${GRAFANA_VERSION}"

install -m 0644 "${OBS_DIR}/prometheus.yml" /etc/prometheus/prometheus.yml
install -m 0644 "${OBS_DIR}/alerts.yml" /etc/prometheus/cfanalisis-alerts.yml
install -m 0644 "${OBS_DIR}/blackbox.yml" /etc/prometheus/blackbox.yml

worker_secret="$(sed -n 's/^WORKER_SECRET=//p' "${WORKER_ENV}" | tail -n 1)"
if [ "${#worker_secret}" -lt 32 ]; then
  echo 'WORKER_SECRET ausente o demasiado corto' >&2
  exit 1
fi
printf '%s' "${worker_secret}" > /etc/prometheus/cfanalisis-worker.token
chown root:prometheus /etc/prometheus/cfanalisis-worker.token
chmod 0640 /etc/prometheus/cfanalisis-worker.token

telegram_token="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "${HEALTH_ENV}" | tail -n 1)"
telegram_chat="$(sed -n 's/^TELEGRAM_CHAT_ID=//p' "${HEALTH_ENV}" | tail -n 1)"
if [ -z "${telegram_token}" ] || ! [[ "${telegram_chat}" =~ ^-?[0-9]+$ ]]; then
  echo 'Credenciales Telegram de health.env no válidas' >&2
  exit 1
fi
printf '%s' "${telegram_token}" > /etc/prometheus/telegram-bot-token
chown root:prometheus /etc/prometheus/telegram-bot-token
chmod 0640 /etc/prometheus/telegram-bot-token
sed "s/__CHAT_ID__/${telegram_chat}/" "${OBS_DIR}/alertmanager.yml.template" \
  > /etc/prometheus/alertmanager.yml
chown root:prometheus /etc/prometheus/alertmanager.yml
chmod 0640 /etc/prometheus/alertmanager.yml

if ! sudo -u postgres psql -XAtqc "select 1 from pg_roles where rolname='prometheus'" | grep -qx 1; then
  sudo -u postgres createuser --login prometheus
fi
sudo -u postgres psql -Xv ON_ERROR_STOP=1 -c 'GRANT pg_monitor TO prometheus'

install -d -o prometheus -g prometheus -m 0755 /var/lib/prometheus/node-exporter
install -d -o grafana -g grafana -m 0755 \
  /var/lib/grafana/dashboards/cfanalisis \
  /etc/grafana/provisioning/datasources \
  /etc/grafana/provisioning/dashboards
install -m 0644 "${OBS_DIR}/grafana/datasource.yml" /etc/grafana/provisioning/datasources/cfanalisis.yml
install -m 0644 "${OBS_DIR}/grafana/dashboard-provider.yml" /etc/grafana/provisioning/dashboards/cfanalisis.yml
install -m 0644 "${OBS_DIR}/grafana/cfanalisis-overview.json" /var/lib/grafana/dashboards/cfanalisis/overview.json
chown grafana:grafana /var/lib/grafana/dashboards/cfanalisis/overview.json

install -d -m 0755 \
  /etc/systemd/system/prometheus.service.d \
  /etc/systemd/system/prometheus-alertmanager.service.d \
  /etc/systemd/system/prometheus-node-exporter.service.d \
  /etc/systemd/system/prometheus-postgres-exporter.service.d \
  /etc/systemd/system/prometheus-redis-exporter.service.d \
  /etc/systemd/system/prometheus-blackbox-exporter.service.d \
  /etc/systemd/system/grafana-server.service.d

install -m 0644 "${OBS_DIR}/systemd/prometheus.conf" /etc/systemd/system/prometheus.service.d/override.conf
install -m 0644 "${OBS_DIR}/systemd/alertmanager.conf" /etc/systemd/system/prometheus-alertmanager.service.d/override.conf
install -m 0644 "${OBS_DIR}/systemd/node-exporter.conf" /etc/systemd/system/prometheus-node-exporter.service.d/override.conf
install -m 0644 "${OBS_DIR}/systemd/postgres-exporter.conf" /etc/systemd/system/prometheus-postgres-exporter.service.d/override.conf
install -m 0644 "${OBS_DIR}/systemd/redis-exporter.conf" /etc/systemd/system/prometheus-redis-exporter.service.d/override.conf
install -m 0644 "${OBS_DIR}/systemd/blackbox-exporter.conf" /etc/systemd/system/prometheus-blackbox-exporter.service.d/override.conf
install -m 0644 "${OBS_DIR}/systemd/grafana.conf" /etc/systemd/system/grafana-server.service.d/override.conf

/usr/bin/promtool check config /etc/prometheus/prometheus.yml
/usr/bin/promtool check rules /etc/prometheus/cfanalisis-alerts.yml
/usr/bin/amtool check-config /etc/prometheus/alertmanager.yml

systemctl daemon-reload
systemctl enable --now \
  prometheus prometheus-alertmanager prometheus-node-exporter \
  prometheus-postgres-exporter prometheus-redis-exporter \
  prometheus-blackbox-exporter grafana-server
systemctl restart \
  prometheus prometheus-alertmanager prometheus-node-exporter \
  prometheus-postgres-exporter prometheus-redis-exporter \
  prometheus-blackbox-exporter grafana-server

if [ ! -s /root/.cfanalisis-grafana-admin-password ]; then
  openssl rand -base64 32 > /root/.cfanalisis-grafana-admin-password
  chmod 0600 /root/.cfanalisis-grafana-admin-password
fi
grafana cli admin reset-admin-password "$(cat /root/.cfanalisis-grafana-admin-password)" >/dev/null
systemctl restart grafana-server

"${REPO_DIR}/scripts/vps/backup_status_metrics.sh"
echo 'Observabilidad activa: Prometheus 127.0.0.1:9090, Grafana 127.0.0.1:3300.'
