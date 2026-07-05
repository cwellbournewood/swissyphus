# Deploying Swissyphus on a Swiss VPS

Tested end-to-end locally (Docker Compose: Caddy reverse proxy → Swissyphus container, automatic TLS, live tool calls through the proxy). Total infra cost target: **under CHF 5/month**.

## 1. Provision the cheapest Swiss VPS

**[Infomaniak VPS Lite](https://www.infomaniak.com/en/hosting/vps-cloud/prices)** — Swiss-owned, Swiss datacenters, from ~CHF 3–4/month for the smallest tier (1 vCPU / 2 GB RAM, enough for this workload). Alternative: **Exoscale** (Swiss, more "cloud-native" feel, similar micro-instance pricing) if you'd rather have an API-driven provider from day one.

Steps (Infomaniak, but nearly identical everywhere):
1. Order the smallest VPS/Cloud Server, Ubuntu 24.04, in the Geneva/Zurich zone.
2. Note the public IPv4 address.
3. `ssh root@<ip>` and install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```

## 2. Point your domain

Buy/keep the domain wherever (GoDaddy is fine *just for the domain* — the earlier caution was about hosting there, not registering there). In its DNS settings, add:

```
A    api.yourdomain.ch    →  <VPS public IP>
```

Propagation is usually minutes, sometimes up to an hour.

## 3. Deploy

```bash
git clone https://github.com/<you>/swissyphus.git
cd swissyphus/deploy
cp .env.example .env
nano .env   # set DOMAIN=api.yourdomain.ch, EMAIL=you@example.com, ADMIN_TOKEN=$(openssl rand -hex 32)
docker compose up -d --build
```

Caddy requests a Let's Encrypt certificate for `DOMAIN` automatically on first request — no certbot, no manual renewal. Swissyphus's API keys and usage data persist in the `swissyphus-data` volume across restarts and upgrades.

## 4. Verify

```bash
curl https://api.yourdomain.ch/v1/health
curl -X POST https://api.yourdomain.ch/v1/keys -d '{"email":"you@example.com"}'
curl https://api.yourdomain.ch/v1/tools/get_weather?plz=8001
```

## 5. Watch adoption

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://api.yourdomain.ch/v1/admin/keys
```

Shows every signup, tier, and monthly usage — this is your POC adoption dashboard with zero extra infrastructure.

## Upgrading

```bash
cd swissyphus && git pull
cd deploy && docker compose up -d --build
```

The named volume means keys and usage survive the rebuild.

## Total monthly cost

| Item | Cost |
|---|---|
| Infomaniak VPS Lite (smallest) | ~CHF 3–4 |
| `.ch` domain (amortised) | ~CHF 1–2 |
| TLS certificate | free (Let's Encrypt via Caddy) |
| **Total** | **~CHF 5/month** |
