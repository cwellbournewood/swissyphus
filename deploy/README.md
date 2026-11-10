# Deploying Swissyphus on a Swiss VPS

Tested end-to-end locally with Docker Compose: Caddy reverse proxy in front of the Swissyphus
container, automatic TLS, and live tool calls through the proxy. The target total infra cost is
**under CHF 5/month**.

What you get: Caddy terminates TLS (Let's Encrypt) and sets security headers. Swissyphus runs
behind it with `SWISSYPHUS_REQUIRE_TLS=1` and `SWISSYPHUS_TRUST_PROXY=1`. Container logs are
capped at 5 × 10 MB per service, and the upstream response cache persists in the
`swissyphus-data` volume. There are no accounts, API keys or quotas to manage: every caller gets
the same per-IP rate limit.

## 1. Provision the cheapest Swiss VPS

**[Infomaniak VPS Lite](https://www.infomaniak.com/en/hosting/vps-cloud/prices)** is
Swiss-owned, runs in Swiss datacenters, and costs from about CHF 3–4/month for the smallest tier
(1 vCPU / 2 GB RAM, which is enough for this workload). **Exoscale** is a Swiss alternative with
a more "cloud-native" feel and similar micro-instance pricing, if you'd rather have an
API-driven provider from day one.

Steps (Infomaniak, but nearly identical everywhere):
1. Order the smallest VPS/Cloud Server, Ubuntu 24.04, in the Geneva/Zurich zone.
2. Note the public IPv4 address.
3. `ssh root@<ip>` and install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
4. Firewall: allow only 22, 80 and 443 (TCP) and 443/UDP (HTTP/3). **Never publish port 8000**.
   The container trusts `X-Forwarded-For` because only Caddy can reach it.

> The hosting provider processes the stored data (container logs) on your behalf. It is
> listed as a processor in [`ROPA.md`](../ROPA.md). If you use a provider other than
> Infomaniak, update `ROPA.md` and `PRIVACY.md` before you open the deployment to users.

## 2. Point your domain

Buy or keep the domain with any registrar. In its DNS settings, add:

```
A    api.yourdomain.ch    →  <VPS public IP>
```

Propagation usually takes minutes, and sometimes up to an hour.

## 3. Deploy

```bash
git clone https://github.com/cwellbournewood/swissyphus.git
cd swissyphus/deploy
cp .env.example .env && chmod 600 .env
nano .env   # DOMAIN and EMAIL
docker compose pull            # prebuilt multi-arch image from ghcr.io
docker compose up -d
```

If the GHCR image isn't reachable (for example, before the package is public), build from the
checkout instead: `docker compose up -d --build`.

Caddy requests a Let's Encrypt certificate for `DOMAIN` automatically on the first request. You
don't need certbot or manual renewal. Caddy starts only after the Swissyphus container reports
healthy.

### Settings in `docker-compose.yml`

| Setting | Why |
|---|---|
| `SWISSYPHUS_REQUIRE_TLS=1` | Rejects plain-HTTP requests (except `GET /v1/health`). HTTPS is detected from `X-Forwarded-Proto`, so the server **refuses to start** unless `SWISSYPHUS_TRUST_PROXY=1` is also set. |
| `SWISSYPHUS_TRUST_PROXY=1` | Takes the client IP from the **right-most** `X-Forwarded-For` hop, which Caddy sets, and honours `X-Forwarded-Proto`. This is correct **only** because Caddy is the sole way in. Never set it on a directly exposed container, because clients could then spoof their IP and dodge rate limits. |
| `logging: json-file, 10m × 5` | Caps logs, which can include client IPs in Caddy's error log, at about 50 MB per container. Rotated logs are deleted, so IP retention is bounded (see [`PRIVACY.md`](../PRIVACY.md)). |
| `stop_grace_period: 20s` | On SIGTERM the server stops accepting connections, drains in-flight requests for up to 10 s and exits 0. |
| `ZEFIX_USER` / `ZEFIX_PASS` | Optional official ZefixPublicREST credentials (issued by the Federal Office of Justice). |

For every other variable (body cap, cache size, health-check TTL…), see the environment table in
the [configuration reference](../docs/HOSTING.md#configuration).

## 4. Verify

```bash
curl https://api.yourdomain.ch/v1/health
curl https://api.yourdomain.ch/v1/tools/get_weather?plz=8001
curl -sI https://api.yourdomain.ch/v1/health | grep -i strict-transport   # security headers present
docker compose ps                                                          # swissyphus: (healthy)
```

## 5. Monitor

- **External uptime check.** Add an HTTP monitor on `https://api.yourdomain.ch/v1/health` that
  alerts you by email or push. Any hosted checker works, for example UptimeRobot, Better Stack or
  Infomaniak's own monitoring; a 5-minute interval is plenty. Point it at `/v1/health`, **not**
  `/v1/health/sources`, which probes every upstream.
- **Upstream drift.** The repo's nightly [live canary](../.github/workflows/live-canary.yml)
  opens a `live-canary` GitHub issue when upstream sources break.

> The volume has a fixed name, `swissyphus-data`, and holds only the upstream response cache
> (public source data). It needs no backup: if it is lost, the cache refills from the sources.
> Deployments from before the removal of API keys may still have a `keys.json` in it, which is no
> longer read. Delete it:
> ```bash
> docker run --rm -v swissyphus-data:/data alpine sh -c 'rm -f /data/keys.json /data/keys.json.*'
> ```

## 6. Upgrading

```bash
cd swissyphus/deploy
git pull                         # picks up compose/Caddy changes
docker compose pull              # new image
docker compose up -d             # recreates only what changed; graceful SIGTERM, then restart
docker image prune -f
```

To pin a version, set `SWISSYPHUS_TAG=v1.0.2` in `.env`. To roll back, set the previous tag and
run `docker compose up -d`. The named volume keeps the response cache across upgrades. Read the
[CHANGELOG](../CHANGELOG.md) before upgrading across minor versions.

To build from the checkout instead of pulling: `docker compose up -d --build`.

## Total monthly cost

| Item | Cost |
|---|---|
| Infomaniak VPS Lite (smallest) | ~CHF 3–4 |
| `.ch` domain (amortised) | ~CHF 1–2 |
| TLS certificate | free (Let's Encrypt via Caddy) |
| **Total** | **~CHF 5/month** |
