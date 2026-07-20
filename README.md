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

| id | game | role |
|---|---|---|
| `10236012001` | Butter Wax Tower | mine |
| `10480688709` | ASMR Squishy Obby | mine |
| `10236023188` | ASMR Tower | rival |

Each id is tried as a **universe id** first; any that a direct read can't find is
resolved as a **place id** (`/universes/v1/places/{id}/universe`) and the resolved
universe id is used. All three above are universe ids (verified live).

## How it runs

`.github/workflows/poll.yml` runs `poll.mjs` (Node 20, zero dependencies) on a
`*/15 * * * *` cron plus `workflow_dispatch`, and commits the updated `ccu.json`
with the built-in `GITHUB_TOKEN` (`contents: write`). **No PAT, no secret.**

Run it by hand from the **Actions** tab → *poll-ccu* → *Run workflow*, or locally:

```sh
node poll.mjs
```

Data lives in `ccu.json` as `{ "updated": <iso>, "readings": [ { "ts": <iso>,
"games": [ { universeId, name, playing, visits, favourites, upVotes, downVotes } ]
} ] }`, trimmed to a rolling ~90-day window.
