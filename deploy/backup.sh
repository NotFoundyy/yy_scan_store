#!/usr/bin/env sh
set -eu

cd /opt/store-scan
mkdir -p backups
stamp="$(date +%Y%m%d-%H%M%S)"
docker compose exec -T postgres pg_dump -U store_scan -d store_scan | gzip > "backups/store-scan-$stamp.sql.gz"
find backups -type f -name 'store-scan-*.sql.gz' -mtime +7 -delete
