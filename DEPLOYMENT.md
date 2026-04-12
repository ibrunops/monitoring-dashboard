# Deployment Guide

This repository intentionally documents a **generic** deployment approach. It does not include any environment-specific hostnames, usernames, IPs, or infrastructure identifiers.

## Recommended architecture

For production use, prefer this shape:

1. Run the app locally on the host
2. Bind it to `127.0.0.1`
3. Put Caddy or Nginx in front of it on `80/443`
4. Add authentication at the proxy layer if needed

Why: the dashboard surfaces operational data about the machine, so direct public exposure is rarely a good default.

## Example environment

```bash
HOST=127.0.0.1
PORT=4318
NODE_ENV=production
```

## Build and run

```bash
npm install
npm run build
npm start
```

## systemd example

Example service unit:

```ini
[Unit]
Description=Monitoring Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/monitoring-dashboard
ExecStart=/usr/bin/node dist/server/index.js
Restart=always
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=4318

[Install]
WantedBy=multi-user.target
```

## Reverse proxy example (Caddy)

```caddy
monitor.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4318

    header {
        X-Content-Type-Options nosniff
        X-Frame-Options SAMEORIGIN
        Referrer-Policy strict-origin-when-cross-origin
        Permissions-Policy interest-cohort=()
    }
}
```

## Hardening recommendations

- keep the app bound to localhost
- avoid exposing the raw app port publicly
- protect the dashboard with upstream auth unless the deployment is intentionally public
- restrict firewall access to the reverse proxy only
- sanitize screenshots before sharing externally

## Validation checklist

- app responds locally on the configured port
- reverse proxy forwards correctly
- TLS terminates at the proxy
- no unexpected secrets or machine-specific paths are committed
- build completes successfully before deployment
