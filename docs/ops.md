# Narrative — Operations Runbook

Stav: **M6 baseline**. Full runbook v M29.

---

## Health checks

```bash
# API server
curl http://localhost:3001/health
# → { "status": "ok" }

# Prometheus metriky
curl http://localhost:3001/metrics
# → Prometheus text format (viz níže)
```

Pro produkci nahraď `localhost:3001` svou doménou / interní adresou.

---

## Metriky (/metrics)

Endpoint vrací Prometheus text format (version 0.0.4).

| Metrika                            | Typ     | Popis                                                               |
| ---------------------------------- | ------- | ------------------------------------------------------------------- |
| `narrative_ws_connections`         | gauge   | Aktuální aktivní Hocuspocus WebSocket connections                   |
| `narrative_updates_ingested_total` | counter | Celkový počet Yjs document flush operací (per-flush, ne per-update) |
| `narrative_updates_bytes_total`    | counter | Celkový počet bytů Yjs updates uložených do Postgres                |

**Interpretace**:

- `narrative_ws_connections` > 0 = klienti připojeni; 0 = žádný aktivní editor
- `narrative_updates_ingested_total` roste s každým save flushem (defaultně debounced 2s po posledním Yjs update)
- Vysoké `narrative_updates_bytes_total` = velké dokumenty nebo intenzivní editace

**TODO(M29)**: Přidat auth (Bearer token nebo IP allowlist) na `/metrics` před expozicí na veřejný internet.

---

## Sentry

Error tracking — dev-gated (žádný init bez DSN).

| Env var              | Popis                                                          |
| -------------------- | -------------------------------------------------------------- |
| `SENTRY_DSN`         | Server DSN — pokud prázdné, Sentry se neinicializuje           |
| `VITE_SENTRY_DSN`    | Client (browser) DSN — pokud prázdné, Sentry se neinicializuje |
| `VITE_BUILD_VERSION` | Release string pro Sentry (např. git sha); default `dev`       |

**Chování bez DSN**: tiché, žádný overhead, žádné errors. Dev-friendly.

**Nastavení pro produkci**:

1. Vytvoř projekt v Sentry (sentry.io nebo self-hosted)
2. Zkopíruj DSN do `.env` (server) a jako Vite build arg (client)
3. Restart server / rebuild frontend

---

## Synthetic load harness

Pro stress testování serveru lokálně nebo v CI:

```bash
# Spusť server (dev nebo prod build)
pnpm --filter server dev

# Spusť všechny load scénáře
pnpm load:all

# Jednotlivé scénáře
pnpm load:hotedit    # 5 clients × 200 mutations
pnpm load:awareness  # 15 clients × 30 Hz × 30s
pnpm load:growth     # 1000 objects initial sync
```

**Očekávaná čísla** (ze spike B, 2026-04-19, localhost):

- Hot edit observer latency avg: ~0.02ms (threshold: < 20ms)
- Awareness latency avg: ~4.5ms (threshold: < 100ms)
- Doc sync 1000 objects: ~18ms (threshold: < 3000ms)
- Encoded doc size: ~228KB (threshold: < 1MB)

Viz `docs/handoff/spike-b-yjs-scale.md` pro detailní breakdown.

---

## Client-side performance overlay (DEV only)

V dev buildu: stiskni **Ctrl+Shift+M** v editoru pro zobrazení overlay s:

- FPS (rolling 1s average)
- Frame time (avg, p99)
- WebSocket connection status

Overlay se nezobrazí v produkčním buildu (`import.meta.env.DEV === false`).

---

## Docker Compose

```bash
# Dev
docker compose up -d

# Prod (s override)
docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml up -d
```

Viz `infra/docker-compose.yml` pro detaily.

---

## Postgres

```bash
# Dev migrace (automatické při server startu v dev mode)
pnpm --filter server db:migrate

# Manuální migrace (prod)
pnpm --filter server db:migrate
```

---

## Incident response (TODO M29)

M29 přidá:

- Prometheus + Grafana dashboards
- Alerting rules (connections, error rate, latency)
- Pagerduty / webhook integrace
- Runbook pro common incidents (DB down, OOM, WS storm)
- Backup restore drill postup
