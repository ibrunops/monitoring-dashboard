# Security Considerations

Monitoring Dashboard exposes machine telemetry and local service inventory. That is useful operationally, but it also means the dashboard can disclose information an attacker would enjoy far too much.

## What the app may reveal

- host OS and kernel details
- CPU, memory, disk, and network activity
- local listening ports and bind scope
- top processes by CPU or RAM
- local OpenClaw runtime presence

## Recommended deployment posture

- bind the app to `127.0.0.1`
- publish it behind a reverse proxy
- add authentication upstream for non-demo environments
- do not expose it publicly unless that tradeoff is explicit
- review data sensitivity before recording demos or sharing screenshots

## Repo hygiene

This public repo should not contain:
- host-specific usernames or home directories
- real production hostnames unless deliberately public
- secrets, tokens, passwords, API keys, or cookies
- internal incident notes or operational learnings not meant for publication
- compiled assets, dependencies, or tunnel binaries

## Before pushing changes

Run a quick review for:
- `.env` files
- embedded credentials
- infrastructure identifiers
- screenshots with sensitive operational data
- notes/logs that belong in internal docs, not in the public repo
