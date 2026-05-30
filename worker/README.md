# Exposure Analytics Worker

Cloudflare Worker + D1 backend for carousel exposure tracking, operator reports, site reports, runtime health, alerts, monitor targets, and notification bookkeeping.

## Deploy

```bash
npx wrangler login
npx wrangler d1 execute exposure_analytics --remote --file ./sql/schema.sql
npx wrangler deploy
```

Apply incremental migrations once per production database:

```bash
npx wrangler d1 execute exposure_analytics --remote --file ./sql/migration_005_player_health_alerts.sql
npx wrangler d1 execute exposure_analytics --remote --file ./sql/migration_006_monitoring_notifications.sql
```

## Public Endpoint

- `POST /api/exposure` - append-only event ingestion from `carousel.js`.
- `GET /health` - Worker health check.

## Authenticated Endpoints

Use `POST /api/auth/login` to get a Bearer token first.

- `GET /api/operator-report?from=<ms>&to=<ms>`
- `GET /api/operator-detail?uid=<uid>&from=<ms>&to=<ms>`
- `GET /api/site-report?from=<ms>&to=<ms>` - production view by default: requires a non-empty playback UID and excludes diagnostic UIDs (`SOAK_`, `MANUAL_`, `TEST_`, etc.); add `include_diagnostics=1` for troubleshooting.
- `GET /api/session-events?sid=<sid>`
- `GET /api/player-health[?uid=<uid>]`
- `GET /api/alerts?status=open|acknowledged|resolved|all&uid=<uid>&limit=300`
- `POST /api/alerts/ack`
- `POST /api/alerts/mark-notified`
- `GET/POST/DELETE /api/monitor-targets`
- `GET/POST/DELETE /api/operators`
- `GET/POST/DELETE /api/sites`
- `GET/POST/DELETE /api/accounts`

## Runtime Health Tables

- `player_status`: derived latest state by `uid`; safe to rebuild from `exposure_events` if needed.
- `monitor_targets`: explicit production UIDs/tasks to monitor; historical UIDs do not create stale alerts unless enabled here.
- `alert_events`: derived alert history for stale heartbeats, missing expected URLs, large offline queues, and flush failures.

`exposure_events` remains the source of truth for reports.
