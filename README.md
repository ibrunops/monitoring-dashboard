# Monitoring Dashboard

Monitoring Dashboard is a lightweight host operations dashboard built with Express, React, TypeScript, and Recharts.

It provides a single-page view of:
- live CPU, memory, disk, and network telemetry
- rolling history windows (5m, 30m, 1h)
- a summarized security posture score
- deduplicated listener inventory with severity hints
- top process activity
- local OpenClaw service detection

## Why this project exists

Most small monitoring dashboards are either too shallow or too infrastructure-heavy for a single host. Monitoring Dashboard aims for the middle ground: easy to run, visually clear, and opinionated enough to surface what deserves attention first.

## Stack

- **Backend**: Express + TypeScript
- **Frontend**: React + Vite + TypeScript
- **Charts**: Recharts
- **System metrics**: `systeminformation`
- **Icons**: `lucide-react`

## Features

- Live dashboard with server-sent events and graceful fallback polling
- Time-windowed charts for CPU, memory, and network traffic
- Security posture summary based on observed local listeners and firewall signals
- Listener deduplication across IPv4/IPv6 binds
- Process table sortable by CPU or RAM
- Mobile-friendly layout with stacked table cards
- No external SaaS dependency required

## Quick start

### Requirements

- Node.js 20+
- npm 10+
- Linux host recommended for the richest telemetry

### Install

```bash
npm install
```

### Development

```bash
npm run dev
```

This starts:
- the API server
- the Vite frontend dev server

### Production build

```bash
npm run build
npm start
```

By default the server binds to `127.0.0.1:4318`.

## Configuration

Environment variables:

- `HOST` — bind address, defaults to `127.0.0.1`
- `PORT` — HTTP port, defaults to `4318`
- `NODE_ENV` — use `production` for built assets

## API

### `GET /api/health`
Simple health endpoint.

### `GET /api/dashboard?window=5m|30m|1h`
Returns the dashboard payload, including current metrics, security posture, services, and selected history window.

### `GET /api/stream?window=5m|30m|1h`
Server-sent events endpoint for near-real-time updates.

## Security notes

This dashboard can reveal operational details about the host it runs on.

For public or semi-public deployments:
- keep the application bound to localhost whenever possible
- expose it behind a reverse proxy
- add authentication upstream if the data should not be world-readable
- review listener/process data before sharing screenshots or demos

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) and [`SECURITY.md`](./SECURITY.md).

## Project structure

```text
.
├── server/           # Express API and telemetry collection
├── src/              # React frontend
├── index.html        # Vite entry HTML
├── package.json
├── tsconfig.json
├── tsconfig.server.json
└── vite.config.ts
```

## Roadmap ideas

- authentication and role-based visibility
- pluggable alert thresholds
- persistence for longer historical windows
- exportable incident snapshots
- containerized deployment option

## License

No license file is included yet. Add one before publishing if you want to grant reuse rights explicitly.
