# Exposure Analytics Worker

## Quick Start

1. Update `wrangler.toml` with your real `database_id`.
2. Login:

```bash
npx wrangler login
```

3. Initialize schema:

```bash
npx wrangler d1 execute exposure_analytics --remote --file ./sql/schema.sql
```

4. Optional fixture seed:

```bash
npx wrangler d1 execute exposure_analytics --remote --file ./sql/seed-fixture.sql
```

5. Deploy:

```bash
npx wrangler deploy
```

## Endpoints

- `POST /api/exposure`
- `POST /api/config/urls` (sync scheduler URL list)
- `GET /api/report?from=<ms>&to=<ms>&url=<optional>&urls=<u1,u2,...>&page=1&page_size=50`
- `GET /api/report.csv?from=<ms>&to=<ms>&url=<optional>&urls=<u1,u2,...>`
- `GET /health`

## Repeated IP Metric

`daily_repeat_ip` uses: same URL + same day + same IP with exposures >= 2.
