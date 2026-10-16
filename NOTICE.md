# NOTICE

This project is MIT-licensed. It redistributes a modified copy of third-party code, whose
attribution and license terms follow.

## vendor/ofm — dsh-our-free-model

`vendor/ofm/` is the standalone slice of **dsh-our-free-model**, taken at upstream `v2.3.0`
(commit `ac4c55ef`) with the small set of upstream fixes that landed after it.

- Upstream: https://github.com/Ebony-Vinyl/dsh-our-free-model
- Copyright (c) 2026 Ebony-Vinyl
- License: MIT — see `vendor/ofm/LICENSE`, kept verbatim as upstream ships it.

Two deliberate local changes are applied, both documented in the README's
"与上游的差异" section. They are kept in `src/` where possible so future upstream syncs
stay a clean three-way merge:

1. **Channel scoping** — `vendor/ofm/packages/standalone/service.mjs`,
   `vendor/ofm/packages/standalone/channels/worker.mjs` and the built console under
   `vendor/ofm/packages/standalone/web/` are trimmed to the twelve account channels.
   The anonymous free pool, Kilo, the EAC lane, the aggregate registry and the combo/token
   saver lanes are removed rather than hidden.

2. **macOS stale-lock guard** — implemented in `src/service.mjs` (`acquireLockGuard`), outside
   `vendor/`, so that it does not conflict with upstream's own lock changes.

Upstream's `channel-pack` source (`vendor/channel-pack/`) is **not** redistributed here: this
plugin runs the prebuilt pack that upstream ships inside the standalone slice.
