#!/usr/bin/env node
/**
 * MXF CCU poller — records Roblox concurrent-players (CCU) history 24/7 on
 * GitHub's own infra, independent of whether Max's PC is on. Roblox's Games API
 * is fully PUBLIC (no auth), so the poller lives here; the MXF MASTERMIND OS
 * reads this repo's ccu.json for the CCU chart, the radar's overnight digest and
 * what Jarvis says about the night.
 *
 * WHICH GAMES: universes.json in this repo — `own` (Max's games) and `rivals`
 * (his Rival radar watchlist). The OS's "Sync" button writes that file (P64).
 *
 * LAW 9 (the Roblox reality): record ONLY what the public API exposes — live
 * CCU (`playing`), total visits, favourites, and up/down votes. NEVER revenue,
 * DAU/MAU, playtime or retention (those live only in the Creator Dashboard).
 *
 * HONESTY: a non-200 response or a game the API does not return is a SKIPPED
 * reading — an honest gap (null) — never a fabricated zero. A tick with nothing
 * readable writes nothing at all.
 *
 * Node 20+ (global fetch). No dependencies, no secrets: the workflow commits the
 * updated ccu.json with the built-in GITHUB_TOKEN (contents: write). No PAT.
 *
 * ── ccu.json, version 2 (P64) — compact, because the OS downloads it ──────────
 *   {
 *     "v": 2,
 *     "updated": "<iso>",
 *     "names": { "<universeId>": "<name>" },
 *     "cols": [ { "p": [ids…], "f": [ids…] } ],
 *     "latest": { "ts": "<iso>", "games": [ { universeId, name, playing, visits,
 *                 favourites, upVotes, downVotes } ] },
 *     "readings": [ [ <epoch seconds>, <col index>, <playing for each id in p>…,
 *                     <visits, favourites, upVotes, downVotes for each id in f>… ] ]
 *   }
 * `p` = every game polled that tick; `f` = the games whose visits, favourites and
 * votes are kept in history (Max's own). A rival's history is its player count
 * only; its full stats ride in `latest`. A missing figure is null, never 0.
 * Version 1 (`{ readings: [ { ts, games: [...] } ] }`) is converted on the first run.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const CCU_FILE = new URL('./ccu.json', import.meta.url)
const UNIVERSES_FILE = new URL('./universes.json', import.meta.url)
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000 // rolling ~90-day retention

const GAMES = 'https://games.roblox.com/v1/games'
const VOTES = 'https://games.roblox.com/v1/games/votes'
const PLACE_UNIVERSE = (id) => `https://apis.roblox.com/universes/v1/places/${id}/universe`

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`)
  return r.json()
}

/** universes.json → { own: [ids], rivals: [ids] }. A broken file fails the run loudly. */
async function readUniverses() {
  const raw = JSON.parse(await readFile(UNIVERSES_FILE, 'utf8'))
  const ids = (list) =>
    (Array.isArray(list) ? list : [])
      .map((g) => Number(g?.universeId))
      .filter((n) => Number.isInteger(n) && n > 0)
  const own = [...new Set(ids(raw.own))]
  const rivals = [...new Set(ids(raw.rivals))].filter((id) => !own.includes(id))
  if (own.length + rivals.length === 0) throw new Error('universes.json lists no games')
  return { own, rivals }
}

/**
 * PLACE-ID RESILIENCE. Most configured ids ARE universe ids and the batched
 * games read finds them directly. For any id that the read does NOT return,
 * treat it as a PLACE id and resolve it to its universe id. Returns a map
 * configured id → working universe id (missing = unresolvable this tick).
 */
async function resolveUniverseIds(ids) {
  let found = new Set()
  try {
    const d = await getJson(`${GAMES}?universeIds=${ids.join(',')}`)
    found = new Set((d.data ?? []).map((g) => g.id))
  } catch (e) {
    console.error('direct universe read failed:', e.message)
  }
  const out = new Map()
  for (const id of ids) {
    if (found.has(id)) {
      out.set(id, id)
      continue
    }
    try {
      const u = await getJson(PLACE_UNIVERSE(id))
      if (u.universeId != null) {
        console.error(`resolved place ${id} -> universe ${u.universeId}`)
        out.set(id, u.universeId)
      } else {
        console.error(`id ${id}: not a universe and place-resolve returned null — skipped`)
      }
    } catch (e) {
      console.error(`id ${id}: place-resolve failed (${e.message}) — skipped`)
    }
  }
  return out
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Any stored file → the in-memory history: [{ t (epoch s), p: Map id→playing,
 * f: Map id→[visits, favourites, up, down] }] plus names. v1 readings keep every
 * game's full stats (they had them); nothing is invented for a field that was absent.
 */
export function loadHistory(parsed) {
  const names = new Map()
  const history = []
  if (parsed && parsed.v === 2 && Array.isArray(parsed.readings) && Array.isArray(parsed.cols)) {
    for (const [id, name] of Object.entries(parsed.names ?? {})) names.set(Number(id), name)
    for (const row of parsed.readings) {
      if (!Array.isArray(row)) continue
      const col = parsed.cols[row[1]]
      if (!col) continue
      const p = new Map()
      const f = new Map()
      let i = 2
      for (const id of col.p) p.set(id, num(row[i++]))
      for (const id of col.f) {
        f.set(id, [num(row[i]), num(row[i + 1]), num(row[i + 2]), num(row[i + 3])])
        i += 4
      }
      history.push({ t: row[0], p, f })
    }
    return { history, names }
  }
  const readings = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.readings) ? parsed.readings : []
  for (const r of readings) {
    const ms = Date.parse(r?.ts)
    if (!Number.isFinite(ms) || !Array.isArray(r.games)) continue
    const p = new Map()
    const f = new Map()
    for (const g of r.games) {
      if (!Number.isInteger(g?.universeId)) continue
      if (typeof g.name === 'string' && g.name.trim() !== '') names.set(g.universeId, g.name.trim())
      p.set(g.universeId, num(g.playing))
      f.set(g.universeId, [num(g.visits), num(g.favourites), num(g.upVotes), num(g.downVotes)])
    }
    history.push({ t: Math.round(ms / 1000), p, f })
  }
  return { history, names }
}

/** The in-memory history → the v2 file text. One reading per line, so a commit diff is one line. */
export function renderV2({ history, names, latest }) {
  const cols = []
  const colIndex = new Map()
  const rows = []
  for (const h of history) {
    const p = [...h.p.keys()]
    const f = [...h.f.keys()]
    const key = `${p.join(',')}|${f.join(',')}`
    let ci = colIndex.get(key)
    if (ci === undefined) {
      ci = cols.length
      cols.push({ p, f })
      colIndex.set(key, ci)
    }
    const row = [h.t, ci, ...p.map((id) => h.p.get(id))]
    for (const id of f) row.push(...h.f.get(id))
    rows.push(JSON.stringify(row))
  }
  const head = {
    v: 2,
    updated: latest.ts,
    names: Object.fromEntries([...names.entries()].map(([id, n]) => [String(id), n])),
    cols,
    latest,
  }
  const headJson = JSON.stringify(head)
  return `${headJson.slice(0, -1)},\n"readings":[\n${rows.join(',\n')}\n]}\n`
}

async function poll() {
  const { own, rivals } = await readUniverses()
  const configured = [...own, ...rivals]
  const resolved = await resolveUniverseIds(configured)
  const universeIds = [...new Set(resolved.values())]
  if (universeIds.length === 0) {
    console.error('no resolvable games this tick — skipping (honest gap)')
    return
  }
  const ownResolved = new Set(own.map((id) => resolved.get(id)).filter((id) => id !== undefined))

  let gamesData = []
  let votesData = []
  try {
    gamesData = (await getJson(`${GAMES}?universeIds=${universeIds.join(',')}`)).data ?? []
  } catch (e) {
    console.error('games read failed:', e.message)
  }
  try {
    votesData = (await getJson(`${VOTES}?universeIds=${universeIds.join(',')}`)).data ?? []
  } catch (e) {
    console.error('votes read failed:', e.message)
  }
  const votesById = new Map(votesData.map((v) => [v.id, v]))

  const games = gamesData.map((g) => {
    const votes = votesById.get(g.id)
    return {
      universeId: g.id,
      name: g.name,
      playing: g.playing ?? null,
      visits: g.visits ?? null,
      favourites: g.favoritedCount ?? null,
      upVotes: votes?.upVotes ?? null,
      downVotes: votes?.downVotes ?? null,
    }
  })

  if (games.length === 0) {
    // Nothing the API returned this tick — write NOTHING. An empty snapshot
    // would draw as a real zero; a gap must stay a gap (LAW 9 honesty).
    console.error('no games returned this tick — skipping (honest gap)')
    return
  }

  const ts = new Date().toISOString()
  let parsed = null
  try {
    parsed = JSON.parse(await readFile(CCU_FILE, 'utf8'))
  } catch {
    /* first run — no ccu.json yet */
  }
  const { history, names } = loadHistory(parsed)

  const byId = new Map(games.map((g) => [g.universeId, g]))
  const p = new Map()
  const f = new Map()
  for (const id of universeIds) {
    const g = byId.get(id)
    p.set(id, g?.playing ?? null)
    if (g?.name) names.set(id, g.name)
  }
  for (const id of universeIds) {
    if (!ownResolved.has(id)) continue
    const g = byId.get(id)
    f.set(id, [g?.visits ?? null, g?.favourites ?? null, g?.upVotes ?? null, g?.downVotes ?? null])
  }
  history.push({ t: Math.round(Date.parse(ts) / 1000), p, f })

  const cutoff = Math.round((Date.now() - WINDOW_MS) / 1000)
  const kept = history.filter((h) => Number.isFinite(h.t) && h.t >= cutoff)
  // Names of games nobody polls any more fall away with their last reading.
  const live = new Set(kept.flatMap((h) => [...h.p.keys()]))
  for (const id of [...names.keys()]) if (!live.has(id)) names.delete(id)

  await writeFile(CCU_FILE, renderV2({ history: kept, names, latest: { ts, games } }))

  console.error(`recorded ${games.length} games at ${ts}; history now ${kept.length} readings`)
  for (const g of games) {
    console.error(`  ${g.name}: CCU ${g.playing}, visits ${g.visits}, fav ${g.favourites}, +${g.upVotes}/-${g.downVotes}`)
  }
}

// Run only when executed directly (`node poll.mjs`), so the format can be tested by import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  poll().catch((e) => {
    console.error('poll failed:', e)
    process.exit(1)
  })
}
