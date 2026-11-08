# Deploying Swissyphus on a Swiss VPS

Tested end-to-end locally with Docker Compose: Caddy reverse proxy in front of the Swissyphus
container, automatic TLS, and live tool calls through the proxy. The target total infra cost is
**under CHF 5/month**.

What you get: Caddy terminates TLS (Let's Encrypt) and sets security headers. Swissyphus runs
behind it with `SWISSYPHUS_REQUIRE_TLS=1` and `SWISSYPHUS_TRUST_PROXY=1`. Container logs are
capped at 5 × 10 MB per service, and API keys persist in the `swissyphus-data` volume.

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

> The hosting provider processes the stored data (API-key emails, logs) on your behalf. It is
> listed as a processor in [`ROPA.md`](../ROPA.md). If you use a provider other than
> Infomaniak, update `ROPA.md` and `PRIVACY.md` before launch.

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
nano .env   # DOMAIN, EMAIL, and ADMIN_TOKEN (paste the output of: openssl rand -hex 32)
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
| `ADMIN_TOKEN` | Enables `/v1/admin/*` only when it has **≥ 32 characters**. A shorter or empty value leaves admin disabled (403) and logs a warning. |
| `logging: json-file, 10m × 5` | Caps logs, which include `[security]` lines with client IPs, at about 50 MB per container. Rotated logs are deleted, so IP retention is bounded (see [`PRIVACY.md`](../PRIVACY.md)). |
| `stop_grace_period: 20s` | On SIGTERM the server stops accepting connections, drains in-flight requests for up to 10 s, flushes usage to `keys.json` and exits 0. |
| `ZEFIX_USER` / `ZEFIX_PASS` | Optional official ZefixPublicREST credentials (see [`docs/outreach/`](../docs/outreach/README.md)). |

For every other variable (body cap, cache size, health-check TTL…), see the environment table in
the [configuration reference](../docs/HOSTING.md#configuration).

## 4. Verify

```bash
curl https://api.yourdomain.ch/v1/health
curl -X POST https://api.yourdomain.ch/v1/keys -d '{"email":"you@example.com"}'
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
- **Security events.** `docker compose logs swissyphus | grep '\[security\]'` shows admin-auth
  lockouts and invalid tokens. See [`BREACH_RESPONSE.md`](../BREACH_RESPONSE.md).
- **Adoption.** Every signup, tier and monthly usage count:
  ```bash
  curl -H "Authorization: Bearer $ADMIN_TOKEN" https://api.yourdomain.ch/v1/admin/keys
  ```

## 6. Nightly backup of `keys.json`

API keys (as SHA-256 hashes), signup emails and usage counts live in `keys.json` inside the
`swissyphus-data` volume. Writes are atomic (tmp file + fsync + rename), so copying the file while
the server runs is safe.

Create `/usr/local/bin/swissyphus-backup.sh`:

```bash
#!/bin/sh
set -eu
BACKUP_DIR=/var/backups/swissyphus
RETENTION_DAYS=30          # backups contain emails. Keep this in line with PRIVACY.md.
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
STAMP=$(date +%F)
docker run --rm \
  -v swissyphus-data:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf "/backup/swissyphus-data-$STAMP.tar.gz" -C /data .
chmod 600 "$BACKUP_DIR/swissyphus-data-$STAMP.tar.gz"
find "$BACKUP_DIR" -name 'swissyphus-data-*.tar.gz' -mtime +"$RETENTION_DAYS" -delete
# Loudly flag a corrupt key store (see "Corrupt keys.json" below).
if docker run --rm -v swissyphus-data:/data:ro alpine sh -c 'ls /data/keys.json.corrupt-* >/dev/null 2>&1'; then
  echo "WARNING: keys.json.corrupt-* present in swissyphus-data — restore needed" >&2
  exit 1
fi
```

Then schedule it:

```bash
chmod 700 /usr/local/bin/swissyphus-backup.sh
echo '17 3 * * * root /usr/local/bin/swissyphus-backup.sh >> /var/log/swissyphus-backup.log 2>&1' \
  > /etc/cron.d/swissyphus-backup
```

**Keep an off-site copy.** A backup on the same VPS won't survive losing the VPS. Sync
`/var/backups/swissyphus` to Swiss storage (for example Infomaniak Swiss Backup or kDrive via
`rclone`, or `scp` to another Swiss host) and apply the same 30-day retention there. The archives
contain personal data (emails), so encrypt them in transit and at rest, and keep them in
Switzerland (see [`PRIVACY.md`](../PRIVACY.md)).

> The volume has a fixed name, `swissyphus-data`. **If you deployed before 0.5.0**, Compose named
> it `deploy_swissyphus-data`, and the new compose file will start with an empty volume. Before
> upgrading, copy the data across once:
> ```bash
> docker volume create swissyphus-data
> docker run --rm -v deploy_swissyphus-data:/from:ro -v swissyphus-data:/to alpine \
>   sh -c 'cp -a /from/. /to/'
> ```

## 7. Restore

```bash
cd swissyphus/deploy
docker compose stop swissyphus
docker run --rm \
  -v swissyphus-data:/data \
  -v /var/backups/swissyphus:/backup:ro \
  alpine sh -c 'rm -f /data/keys.json /data/keys.json.tmp \
    && tar xzf /backup/swissyphus-data-YYYY-MM-DD.tar.gz -C /data \
    && chown -R 1000:1000 /data'          # 1000 = the image's non-root `node` user
docker compose start swissyphus
docker compose logs --tail 20 swissyphus    # there should be no "[keys] … is corrupt" line
```

Keys issued after the backup was taken are lost. Their holders can simply sign up again.
Self-service erasures (`DELETE /v1/keys`) made after the backup are **undone** by a restore. To
honour them, re-apply them through the admin API, and record the restore as described in
[`BREACH_RESPONSE.md`](../BREACH_RESPONSE.md) if it was caused by an incident.

### Corrupt `keys.json`

If `keys.json` can't be parsed at startup (for example after a disk-full event or a manual edit),
the server **refuses to start**. It never continues with an empty store that would overwrite
every issued key. It moves the bad file aside to `keys.json.corrupt-<timestamp>` in the same
volume and logs a `[keys] … is corrupt` line.

Because of `restart: unless-stopped`, Docker keeps restarting the container, and every start
keeps refusing while a `keys.json.corrupt-*` file exists and `keys.json` is missing. The API
stays down (fail-closed) instead of silently coming up with an empty key store. What to do:

1. `docker compose logs swissyphus | grep '\[keys\]'` to confirm what happened.
2. Restore the latest good backup (above). Alternatively, repair the `.corrupt-*` file by hand,
   copy it back to `keys.json` and restart.
3. Delete the `.corrupt-*` file once you have recovered. The server will not start while it is
   the only thing in the volume. To start deliberately with **no** keys, delete it without
   restoring.

## 8. Upgrading

```bash
cd swissyphus/deploy
git pull                         # picks up compose/Caddy changes
docker compose pull              # new image
docker compose up -d             # recreates only what changed; graceful SIGTERM, then restart
docker image prune -f
```

To pin a version, set `SWISSYPHUS_TAG=v1.0.0` in `.env`. To roll back, set the previous tag and
run `docker compose up -d`. The named volume means keys and usage survive every upgrade. Read the
[CHANGELOG](../CHANGELOG.md) before upgrading across minor versions.

To build from the checkout instead of pulling: `docker compose up -d --build`.

## Total monthly cost

| Item | Cost |
|---|---|
| Infomaniak VPS Lite (smallest) | ~CHF 3–4 |
| `.ch` domain (amortised) | ~CHF 1–2 |
| TLS certificate | free (Let's Encrypt via Caddy) |
| **Total** | **~CHF 5/month** |
