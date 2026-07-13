// Interactive helper for the full add-tournament workflow:
//   1. Fetches every URL listed in tours-all-challonge.md / tours-all-startgg.md
//      (both fetch_batch.js scripts are idempotent, so this is safe to rerun).
//   2. For each new tournament, asks whether it was singles or doubles (2v2);
//      doubles writes tournament-doubles.json and splits every raw
//      participant/match name on + or & (see parseTeamName in
//      aggregate_players.js) before the per-name dedup pass below, so each
//      half of a team is resolved as its own individual player.
//   3. Finds tournaments that were newly fetched this run and walks through
//      their unique raw player names one at a time, asking you to confirm
//      every name that isn't already pinned to a specific person by an
//      alias or an already-decided split resolution:
//        - a name that exactly matches a KNOWN-AMBIGUOUS name (an existing
//          entry in player-identities.json's `splits`) with no resolution or
//          default covering this tournament yet
//        - a name that exactly matches an existing UNambiguous player is
//          still confirmed ("same player?") rather than silently merged --
//          a name having only ever belonged to one person so far doesn't
//          mean a new appearance of it is that same person. Saying "no"
//          turns it into a split on the spot.
//        - a name that doesn't exactly match anything seen before, but is a
//          close spelling match to an existing player (possible alias)
//      Only names already covered by an alias or a split resolution that
//      already lists this tournament are left to auto-resolve without a
//      prompt.
//   4. For each new tournament, asks for city/state/venue (blank = skip) and
//      writes them to tournament-locations.json.
//   5. For genuinely new players, asks for city/state/country (blank = skip)
//      and an optional card color override, and writes them to
//      player-info.json. Decisions made earlier in the same run are reused
//      automatically (no re-asking) because they're written to the shared
//      identities object as soon as they're made.
//   6. Regenerates players.csv / index.html / index.css / index.js via
//      aggregate_players.js.
//
// Usage: node add_tournaments.js

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const readline = require('node:readline/promises');
const {
  DATA_ROOT, identities, hiddenNames, normName, resolveIdentity,
  displayName, collectChallonge, collectStartgg, buildPlayerStats, parseTeamName,
} = require('./aggregate_players');
const { resolveParticipantName } = require('../challonge/resolve_participant_name');

const IDENTITIES_PATH = path.join(DATA_ROOT, 'player-identities.json');
const PLAYER_INFO_PATH = path.join(DATA_ROOT, 'player-info.json');
const TOURNAMENT_LOCATIONS_PATH = path.join(DATA_ROOT, 'tournament-locations.json');
const TOURNAMENT_DOUBLES_PATH = path.join(DATA_ROOT, 'tournament-doubles.json');
const CHALLONGE_STORE = path.join(DATA_ROOT, 'challonge', 'tournaments.json');
const STARTGG_STORE = path.join(DATA_ROOT, 'start.gg', 'tournaments.json');

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// These three config files are hand-curated with one compact single-line
// entry per array/map item, not JSON.stringify(x, null, 2)'s fully-expanded
// style. Serialize to match that convention so a save from this script
// doesn't blow away the existing formatting on every unrelated entry.

// { "a": 1, "b": [1, 2] } style: padded object braces, tight array
// brackets, space after every colon/comma — matches the hand-authored files.
function compactStringify(value) {
  if (Array.isArray(value)) return `[${value.map(compactStringify).join(', ')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${compactStringify(v)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return JSON.stringify(value);
}

function serializeIdentities(obj) {
  const lines = ['{'];
  const keys = Object.keys(obj);
  keys.forEach((key, i) => {
    const comma = i < keys.length - 1 ? ',' : '';
    if (key === 'aliases') {
      lines.push('  "aliases": [');
      obj.aliases.forEach((a, j) => lines.push(`    ${compactStringify(a)}${j < obj.aliases.length - 1 ? ',' : ''}`));
      lines.push(`  ]${comma}`);
    } else if (key === 'splits') {
      lines.push('  "splits": [');
      obj.splits.forEach((s, j) => {
        lines.push('    {');
        lines.push(`      "name": ${JSON.stringify(s.name)},`);
        lines.push('      "resolutions": [');
        (s.resolutions || []).forEach((r, k) => lines.push(`        ${compactStringify(r)}${k < s.resolutions.length - 1 ? ',' : ''}`));
        lines.push(`      ]${s.default ? ',' : ''}`);
        if (s.default) lines.push(`      "default": ${compactStringify(s.default)}`);
        lines.push(`    }${j < obj.splits.length - 1 ? ',' : ''}`);
      });
      lines.push(`  ]${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${compactStringify(obj[key])}${comma}`);
    }
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}

// Shared shape of player-info.json / tournament-locations.json: a handful of
// _meta string keys, plus one map (`mapKey`) of compact single-line values.
function serializeKeyedMap(obj, mapKey) {
  const lines = ['{'];
  const keys = Object.keys(obj);
  keys.forEach((key, i) => {
    const comma = i < keys.length - 1 ? ',' : '';
    if (key === mapKey) {
      const entryKeys = Object.keys(obj[mapKey]);
      lines.push(`  ${JSON.stringify(mapKey)}: {`);
      entryKeys.forEach((k, j) => {
        lines.push(`    ${JSON.stringify(k)}: ${compactStringify(obj[mapKey][k])}${j < entryKeys.length - 1 ? ',' : ''}`);
      });
      lines.push(`  }${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${compactStringify(obj[key])}${comma}`);
    }
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}

const playerInfoFile = readJson(PLAYER_INFO_PATH, { players: {} });
playerInfoFile.players = playerInfoFile.players || {};

const tournamentLocationsFile = readJson(TOURNAMENT_LOCATIONS_PATH, { locations: {} });
tournamentLocationsFile.locations = tournamentLocationsFile.locations || {};

const tournamentDoublesFile = readJson(TOURNAMENT_DOUBLES_PATH, {});

function saveIdentities() {
  fs.writeFileSync(IDENTITIES_PATH, serializeIdentities(identities));
}
function savePlayerInfo() {
  fs.writeFileSync(PLAYER_INFO_PATH, serializeKeyedMap(playerInfoFile, 'players'));
}
function saveTournamentLocations() {
  fs.writeFileSync(TOURNAMENT_LOCATIONS_PATH, serializeKeyedMap(tournamentLocationsFile, 'locations'));
}
// tournament-doubles.json is a flat { url: true, ... } map (like
// tournament-groups.json) -- no wrapper key, so it gets its own tiny
// serializer instead of reusing serializeKeyedMap.
function saveTournamentDoubles() {
  const lines = ['{'];
  const keys = Object.keys(tournamentDoublesFile);
  keys.forEach((key, i) => {
    lines.push(`${JSON.stringify(key)}: ${compactStringify(tournamentDoublesFile[key])}${i < keys.length - 1 ? ',' : ''}`);
  });
  lines.push('}');
  fs.writeFileSync(TOURNAMENT_DOUBLES_PATH, lines.join('\n') + '\n');
}

// --- Fuzzy matching ---

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function similarity(a, b) {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 1;
  if (la.includes(lb) || lb.includes(la)) return 0.9;
  const dist = levenshtein(la, lb);
  return 1 - dist / Math.max(la.length, lb.length);
}

// --- Id generation ---

function slugify(s) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function monthYearSlug(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  return `${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function collectAllIds() {
  const ids = new Set();
  for (const a of identities.aliases || []) if (a.id) ids.add(a.id);
  for (const s of identities.splits || []) {
    for (const r of s.resolutions || []) if (r.id) ids.add(r.id);
    if (s.default?.id) ids.add(s.default.id);
  }
  return ids;
}

const usedIds = collectAllIds();

function generateId(name, dateStr) {
  const base = `${slugify(name)}-${monthYearSlug(dateStr)}`;
  let id = base;
  let n = 1;
  while (usedIds.has(id)) id = `${base}-${++n}`;
  usedIds.add(id);
  return id;
}

// --- Known player registry (built from all existing tournament history) ---

function buildKnownPlayers(allTournaments) {
  const urlToDate = new Map(allTournaments.map((t) => [t.url, t.date]));
  const players = buildPlayerStats(allTournaments);
  const byId = new Map();
  for (const [id, p] of players) {
    let lastDate = '';
    let lastLabel = '';
    for (const [url, label] of p.tournaments) {
      const date = urlToDate.get(url) || '';
      if (date >= lastDate) { lastDate = date; lastLabel = label; }
    }
    byId.set(id, {
      id,
      displayName: displayName(p),
      allNames: [...p.nameCounts.keys()],
      games: p.games,
      lastDate,
      lastLabel,
    });
  }
  return byId;
}

function fuzzyCandidates(rawName, knownById, limit = 6) {
  const scored = [];
  for (const p of knownById.values()) {
    const best = Math.max(...p.allNames.map((n) => similarity(rawName, n)));
    if (best >= 0.5) scored.push({ ...p, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// --- Prompting ---

async function ask(rl, question) {
  return (await rl.question(question)).trim();
}

async function askChoice(rl, question, maxIndex) {
  while (true) {
    const answer = await ask(rl, question);
    const n = parseInt(answer, 10);
    if (!isNaN(n) && n >= 0 && n <= maxIndex) return n;
    console.log(`  Enter a number from 0 to ${maxIndex}.`);
  }
}

function describeCandidate(c) {
  const seen = c.lastLabel ? `, last: ${c.lastLabel}${c.lastDate ? ` (${c.lastDate})` : ''}` : '';
  return `${c.displayName}  [${c.games} games${seen}]`;
}

async function askLocationAndColor(rl, label) {
  console.log(`  New player: ${label}`);
  const city = await ask(rl, '    City (blank = unknown): ');
  const state = await ask(rl, '    State/Province abbreviation (blank = unknown): ');
  const country = await ask(rl, '    Country (blank = United States): ');
  const colorChoice = await ask(rl, '    Color override: 0 none / 1 purple / 2 green (blank = 0): ');
  const info = {};
  if (city) info.city = city;
  if (state) info.state = state;
  if (country) info.country = country;
  if (colorChoice === '1') info.color = 'purple';
  else if (colorChoice === '2') info.color = 'green';
  return info;
}

// Asks whether a new tournament was singles or doubles (2v2 teams) and
// persists the answer to tournament-doubles.json -- doubles tournaments get
// their raw participant/match names split on + or & (see parseTeamName) so
// each half is deduped/resolved as a normal individual player, and never
// feed the Glicko rating engine (see aggregate_players.js's isDoubles guards).
async function askTournamentFormat(rl, tournament) {
  if (tournament.url in tournamentDoublesFile) return tournamentDoublesFile[tournament.url];
  const answer = (await ask(rl, `\nIs "${tournament.label}" (${tournament.date}) singles or doubles? [s/d] (default s): `)).trim().toLowerCase();
  const isDoubles = answer === 'd' || answer === 'doubles';
  if (isDoubles) {
    tournamentDoublesFile[tournament.url] = true;
    saveTournamentDoubles();
  }
  return isDoubles;
}

async function askTournamentLocation(rl, tournament) {
  if (tournamentLocationsFile.locations[tournament.url]) return; // already set, don't re-ask

  console.log(`\nTournament: ${tournament.label} (${tournament.date})`);
  const nameOverride = await ask(rl, `  Name (blank = keep "${tournament.label}"): `);
  const dateOverride = await ask(rl, `  Date (blank = keep ${tournament.date}, format YYYY-MM-DD): `);
  const city = await ask(rl, '  City (blank = unknown): ');
  const state = await ask(rl, '  State/Province abbreviation (blank = unknown): ');
  const location = await ask(rl, '  Venue (blank = unknown): ');
  const info = {};
  if (nameOverride) info.name = nameOverride;
  if (dateOverride) info.date = dateOverride;
  if (city) info.city = city;
  if (state) info.state = state;
  if (location) info.location = location;
  if (Object.keys(info).length) {
    tournamentLocationsFile.locations[tournament.url] = info;
    saveTournamentLocations();
  }
}

// Merge rawName into an existing known player as an alias. Reuses the
// player's existing alias entry if they have one; otherwise creates a new
// one, only pinning an explicit `id` if the player's id isn't already the
// default lowercased-canonical (i.e. they're a split resolution).
function mergeAsAlias(rawName, candidate) {
  const existing = (identities.aliases || []).find(
    (a) => (a.id || a.canonical.toLowerCase()) === candidate.id
  );
  if (existing) {
    if (!existing.names.some((n) => n.toLowerCase() === rawName.toLowerCase())) {
      existing.names.push(rawName);
    }
    return;
  }
  identities.aliases = identities.aliases || [];
  const entry = { names: [candidate.displayName, rawName], canonical: candidate.displayName };
  if (candidate.id !== candidate.displayName.trim().toLowerCase()) entry.id = candidate.id;
  identities.aliases.push(entry);
}

async function handleSplitCollision(rl, splitEntry, rawName, tournament, knownById) {
  console.log(`\n"${rawName}" is a known ambiguous name (${tournament.label}, ${tournament.date}):`);
  const resolutions = splitEntry.resolutions || [];
  console.log('  0 - New / different person');
  resolutions.forEach((r, i) => {
    const known = knownById.get(r.id);
    console.log(`  ${i + 1} - ${known ? describeCandidate(known) : r.canonical} (id: ${r.id})`);
  });
  const choice = await askChoice(rl, 'Choice: ', resolutions.length);

  if (choice === 0) {
    const id = generateId(rawName, tournament.date);
    resolutions.push({ id, canonical: rawName.trim(), tournaments: [tournament.url] });
    saveIdentities();
    const info = await askLocationAndColor(rl, `${rawName.trim()} (${id})`);
    if (Object.keys(info).length) {
      playerInfoFile.players[id] = info;
      savePlayerInfo();
    }
    return;
  }

  const resolution = resolutions[choice - 1];
  if (!resolution.tournaments.includes(tournament.url)) resolution.tournaments.push(tournament.url);
  saveIdentities();
}

// Even an exact match to an existing UNambiguous name still gets confirmed --
// "Ron" having only ever been one person so far doesn't mean a new "Ron" who
// shows up later is that same person. A "no" here converts the name into a
// split: prior history keeps resolving to the existing player via `default`,
// while this (and any future confirmed-different) occurrence gets a fresh id.
async function handleExactMatchConfirmation(rl, rawName, tournament, existing) {
  console.log(`\n"${rawName}" (${tournament.label}, ${tournament.date}) matches an existing player:`);
  console.log(`  ${describeCandidate(existing)}`);
  const answer = (await ask(rl, 'Same player? [Y/n] (default y): ')).trim().toLowerCase();
  if (answer === '' || answer === 'y' || answer === 'yes') return;

  const newId = generateId(rawName, tournament.date);
  identities.splits = identities.splits || [];
  identities.splits.push({
    name: rawName.trim(),
    resolutions: [{ id: newId, canonical: rawName.trim(), tournaments: [tournament.url] }],
    default: { id: existing.id, canonical: existing.displayName },
  });
  saveIdentities();
  const info = await askLocationAndColor(rl, `${rawName.trim()} (${newId})`);
  if (Object.keys(info).length) {
    playerInfoFile.players[newId] = info;
    savePlayerInfo();
  }
}

async function handleUnresolvedName(rl, rawName, tournament, knownById) {
  const candidates = fuzzyCandidates(rawName, knownById);
  if (candidates.length === 0) {
    const info = await askLocationAndColor(rl, `${rawName} (${tournament.label}, ${tournament.date})`);
    if (Object.keys(info).length) {
      playerInfoFile.players[rawName.trim()] = info;
      savePlayerInfo();
    }
    return;
  }

  console.log(`\n"${rawName}" (${tournament.label}, ${tournament.date}) — possible matches:`);
  console.log('  0 - New player');
  candidates.forEach((c, i) => console.log(`  ${i + 1} - ${describeCandidate(c)}`));
  const choice = await askChoice(rl, 'Choice: ', candidates.length);

  if (choice === 0) {
    const info = await askLocationAndColor(rl, `${rawName} (${tournament.label}, ${tournament.date})`);
    if (Object.keys(info).length) {
      playerInfoFile.players[rawName.trim()] = info;
      savePlayerInfo();
    }
    return;
  }

  mergeAsAlias(rawName, candidates[choice - 1]);
  saveIdentities();
}

// --- Fetch + diff ---

function snapshotUrls(storePath) {
  const store = readJson(storePath, {});
  return new Set(Object.keys(store));
}

function runFetch(scriptPath) {
  execFileSync('node', [scriptPath, '9999'], { stdio: 'inherit' });
}

function newFetchedUrls(storePath, beforeUrls) {
  const store = readJson(storePath, {});
  return new Set(
    Object.entries(store)
      .filter(([url, rec]) => !beforeUrls.has(url) && !rec.error)
      .map(([url]) => url)
  );
}

function rawParticipantNames(url, isStartgg) {
  if (isStartgg) {
    const store = readJson(STARTGG_STORE, {});
    const rec = store[url];
    if (!rec?.entrants) return [];
    return rec.entrants.map((e) => e.participants[0]?.gamerTag || e.name || '').filter(Boolean);
  }
  const store = readJson(CHALLONGE_STORE, {});
  const rec = store[url];
  if (!rec?.tournament) return [];
  return rec.tournament.participants.map((p) => resolveParticipantName(p.participant)).filter(Boolean);
}

async function main() {
  console.log('Fetching Challonge tournaments...');
  const challongeBefore = snapshotUrls(CHALLONGE_STORE);
  runFetch(path.join(DATA_ROOT, 'challonge', 'fetch_batch.js'));
  const newChallongeUrls = newFetchedUrls(CHALLONGE_STORE, challongeBefore);

  console.log('\nFetching start.gg tournaments...');
  const startggBefore = snapshotUrls(STARTGG_STORE);
  runFetch(path.join(DATA_ROOT, 'start.gg', 'fetch_batch.js'));
  const newStartggUrls = newFetchedUrls(STARTGG_STORE, startggBefore);

  const newUrls = new Set([...newChallongeUrls, ...newStartggUrls]);
  if (newUrls.size === 0) {
    console.log('\nNo new tournaments fetched — nothing to dedupe.');
    return;
  }

  const allTournaments = [...collectChallonge(), ...collectStartgg()]
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const knownById = buildKnownPlayers(allTournaments.filter((t) => !newUrls.has(t.url)));

  const newTournaments = allTournaments.filter((t) => newUrls.has(t.url));
  console.log(`\n${newTournaments.length} new tournament(s) to review:`);
  for (const t of newTournaments) console.log(`  - ${t.label} (${t.date}) [${t.source}]`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const t of newTournaments) {
      const isDoublesTournament = await askTournamentFormat(rl, t);
      await askTournamentLocation(rl, t);

      const isStartgg = t.source === 'start.gg';
      const rawNames = [...new Set(rawParticipantNames(t.url, isStartgg))];

      // Doubles participant/team names are "PlayerA + PlayerB" (or "&") --
      // split each into its two halves and dedupe/resolve them individually,
      // same as any singles name, instead of treating the joined string as
      // one (nonexistent) player.
      const names = isDoublesTournament
        ? [...new Set(rawNames.flatMap((raw) => {
            const parts = parseTeamName(raw);
            if (!parts) {
              console.log(`  Could not split team name "${raw}" on + or & -- treating it as a single name.`);
              return [raw];
            }
            return parts;
          }))]
        : rawNames;

      for (const rawName of names) {
        if (hiddenNames.has(normName(rawName).toLowerCase())) continue;

        const identity = resolveIdentity(rawName, t.url);
        const lower = normName(rawName).toLowerCase();
        const isDefaultFallback = identity.id === lower;
        if (!isDefaultFallback) continue; // already resolved via alias or split

        const splitEntry = (identities.splits || []).find((s) => normName(s.name).toLowerCase() === lower);
        if (splitEntry) {
          await handleSplitCollision(rl, splitEntry, rawName, t, knownById);
          continue;
        }

        if (knownById.has(lower)) {
          await handleExactMatchConfirmation(rl, rawName, t, knownById.get(lower));
          continue;
        }

        await handleUnresolvedName(rl, rawName, t, knownById);
        // Register this decision so later tournaments in this batch see it.
        const resolved = resolveIdentity(rawName, t.url);
        if (!knownById.has(resolved.id)) {
          knownById.set(resolved.id, {
            id: resolved.id, displayName: resolved.name, allNames: [rawName],
            games: 0, lastDate: t.date, lastLabel: t.label,
          });
        }
      }
    }
  } finally {
    rl.close();
  }

  console.log('\nRegenerating rankings...');
  execFileSync('node', [path.join(__dirname, 'aggregate_players.js')], { stdio: 'inherit' });
}

if (require.main === module) main();

module.exports = { saveIdentities, savePlayerInfo, saveTournamentLocations, saveTournamentDoubles };
