#!/usr/bin/env node
/**
 * MXF CCU poller — records Roblox concurrent-players (CCU) history 24/7 on
 * GitHub's own infra, independent of whether Max's PC is on. Roblox's Games API
 * is fully PUBLIC (no auth), so the poller lives here; the MXF MASTERMIND OS
 * reads this repo's ccu.json to draw its CCU chart with real history around the
 * OS's own sparse local snapshots.
 *
 * LAW 9 (the Roblox reality): record ONLY what the public API exposes — live
 * CCU (`playing`), total visits, favourites, and up/down votes. NEVER revenue,
 * DAU/MAU, playtime or retention (those live only in the Creator Dashboard).
 *
 * HONESTY: a non-200 response or a game the API does not return is a SKIPPED
 * reading — an honest gap — never a fabricated zero. A tick with nothing
 * readable writes nothing at all.
 *
 * Node 20+ (global fetch). No dependencies, no secrets: the workflow commits the
 * updated ccu.json with the built-in GITHUB_TOKEN (contents: write). No PAT.
 */
import { readFile, writeFile } from 'node:fs/promises'

/** Max's games + the rival, as configured ids. Each is tried as a UNIVERSE id
 *  first; any that a direct read can't find is resolved as a PLACE id (below). */
const CONFIGURED_IDS = [
  10236012001, // Butter Wax Tower
  10480688709, // ASMR Squishy Obby
  10236023188, // ASMR Tower — the rival (a universe id; verified live)
]

const CCU_FILE = new URL('./ccu.json', import.meta.url)
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000 // rolling ~90-day retention

const GAMES = 'https://games.roblox.com/v1/games'
const VOTES = 'https://games.roblox.com/v1/games/votes'
const PLACE_UNIVERSE = (id) => `https://apis.roblox.com/universes/v1/places/${id}/universe`

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`)
  return r.json()
}

/**
 * PLACE-ID RESILIENCE. Most configured ids ARE universe ids and the batched
 * games read finds them directly. For any id that the read does NOT return,
 * treat it as a PLACE id and resolve it to its universe id, then keep the
 * resolved id. Returns the deduped set of working universe ids.
 */
async function resolveUniverseIds(ids) {
  let found = new Set()
  try {
    const d = await getJson(`${GAMES}?universeIds=${ids.join(',')}`)
    found = new Set((d.data ?? []).map((g) => g.id))
  } catch (e) {
    console.error('direct universe read failed:', e.message)
  }
  const universe = new Set()
  for (const id of ids) {
    if (found.has(id)) {
      universe.add(id)
      continue
    }
    // Not a universe id (or the batch missed it) — try place → universe.
    try {
      const u = await getJson(PLACE_UNIVERSE(id))
      if (u.universeId != null) {
        console.error(`resolved place ${id} -> universe ${u.universeId}`)
        universe.add(u.universeId)
      } else {
        console.error(`id ${id}: not a universe and place-resolve returned null — skipped`)
      }
    } catch (e) {
      console.error(`id ${id}: place-resolve failed (${e.message}) — skipped`)
    }
  }
  return [...universe]
}

async function poll() {
  const universeIds = await resolveUniverseIds(CONFIGURED_IDS)
  if (universeIds.length === 0) {
    console.error('no resolvable games this tick — skipping (honest gap)')
    return
  }

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

  const reading = { ts: new Date().toISOString(), games }

  // Load, append, trim to the rolling window. Tolerant of a first run (no file)
  // and of either shape (a bare array, or { readings: [...] }).
  let readings = []
  try {
    const parsed = JSON.parse(await readFile(CCU_FILE, 'utf8'))
    if (Array.isArray(parsed)) readings = parsed
    else if (Array.isArray(parsed.readings)) readings = parsed.readings
  } catch {
    /* first run — no ccu.json yet */
  }
  readings.push(reading)
  const cutoff = Date.now() - WINDOW_MS
  readings = readings.filter((r) => Number.isFinite(Date.parse(r.ts)) && Date.parse(r.ts) >= cutoff)

  await writeFile(CCU_FILE, `${JSON.stringify({ updated: reading.ts, readings }, null, 2)}\n`)

  console.error(`recorded ${games.length} games at ${reading.ts}; history now ${readings.length} readings`)
  for (const g of games) {
    console.error(`  ${g.name}: CCU ${g.playing}, visits ${g.visits}, fav ${g.favourites}, +${g.upVotes}/-${g.downVotes}`)
  }
}

poll().catch((e) => {
  console.error('poll failed:', e)
  process.exit(1)
})
