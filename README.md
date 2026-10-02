# mxf-ccu-log

An always-on **Roblox CCU (concurrent-players) logger** for the MXF MASTERMIND OS.

Roblox's [Games API](https://games.roblox.com/) is fully public (no auth), so this
repo polls it on GitHub's own infrastructure every 15 minutes via a scheduled
GitHub Action — recording history **24/7, whether or not Max's PC is on**. The OS
reads [`ccu.json`](./ccu.json) and draws its CCU chart with this real history
filled in around the OS's own sparser local snapshots.

## What it records (and what it never will)

Per the project's Roblox reality rule, it records **only** what the public API
exposes:

- `playing` — live concurrent players (CCU)
- `visits` — lifetime visits
- `favourites` — favourite count
- `upVotes` / `downVotes` — likes / dislikes

It **never** records revenue, DAU/MAU, playtime or retention — those exist only in
the Creator Dashboard and are not in any API.

## Honesty

A non-200 response, or a game the API simply does not return, is a **skipped
reading — an honest gap**, never a fabricated zero. A tick with nothing readable
writes nothing at all.

## The games

The list lives in [`universes.json`](./universes.json): `own` (Max's games) and
`rivals` (his Rival radar watchlist). The OS writes it: when the watchlist in the
dashboard differs from this file, the Rival radar panel says so and its **Sync**
button commits the new list here with Max's own git login. Since P64 (2 Oct 2026)
it holds his 2 games and 15 rivals.

Each id is tried as a **universe id** first; any that a direct read can't find is
resolved as a **place id** (`/universes/v1/places/{id}/universe`) and the resolved
universe id is used.

## How it runs

`.github/workflows/poll.yml` runs `poll.mjs` (Node 20, zero dependencies) on a
`*/15 * * * *` cron plus `workflow_dispatch`, and commits the updated `ccu.json`
with the built-in `GITHUB_TOKEN` (`contents: write`). **No PAT, no secret.**

Run it by hand from the **Actions** tab → *poll-ccu* → *Run workflow*, or locally:

```sh
node poll.mjs
```

Data lives in `ccu.json`, trimmed to a rolling ~90-day window. Since P64 it is the
compact **version 2** file (the header of `poll.mjs` documents every field): one
line per reading, `[epoch seconds, column set, players per game…, then visits,
favourites, up and down votes for Max's own games]`. A rival's history keeps its
player count only; every game's full stats for the newest reading sit in `latest`.
At 17 games and 90 days it is about 1.2 MB, where the old shape would have been
about 37 MB. The OS reads both shapes, and the first run converts the old one.
