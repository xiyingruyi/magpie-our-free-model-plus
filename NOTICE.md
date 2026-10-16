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
   saver lanes are removed rather than hidden. `channels/worker.mjs` passes the lane scope
   into `apply()`, and `channels/business.mjs` honours it in its background credential work
   (Gemini's nickname repair and refresh timer), so an out-of-scope lane is not silently
   re-added after registration was already filtered.

2. **macOS stale-lock guard** — implemented in `src/service.mjs` (`acquireLockGuard`), outside
   `vendor/`, so that it does not conflict with upstream's own lock changes.

Upstream's `channel-pack` source (`vendor/channel-pack/`) is **not** redistributed here: this
plugin runs the prebuilt pack that upstream ships inside the standalone slice.

## Credentials that upstream ships in cleartext

`vendor/ofm/packages/standalone/channels/business.mjs` carries six credential values written
into the source, not read from the environment. They are **upstream's**, byte for byte — this
project did not add, change or discover them, and they are already public in
`Ebony-Vinyl/dsh-our-free-model` at the same commit. Recorded here (location and fingerprint
only; no values) so that anyone auditing this repository knows they are upstream's and what
they are:

| Constant | Line | Length | sha256[:10] |
|---|---|---|---|
| XFYUN (iFlytek) `accessKeyId` | 42286 | 16 | `b759bc1220` |
| XFYUN `accessKeySecret` | 42287 | 32 | `258c063b18` |
| XFYUN Loomy `appId` | 42288 | 8 | `927d10a0cf` |
| Raccoon phone-cipher secret | 42613 | 16 | `4ef0459caa` |
| Gemini OAuth `client_id` | 66390 | 73 | `bf00c41802` |
| Gemini OAuth `client_secret` | 66391 | 35 | `1d2f041093` |

Two of these are **dead in this build**: the Gemini pair sits on the Google auth flow, and
Gemini is not one of the twelve channels, so its adapter is never registered
(`channels/worker.mjs` skips any provider outside the scope). They are left in place rather
than stripped, because editing them would put this repository at permanent odds with
upstream for no gain — the values are public already.

If any of these are yours to rotate, rotate them at the vendor; the fix does not belong in
this repository.

