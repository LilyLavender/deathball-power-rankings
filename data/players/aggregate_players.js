// Aggregate per-player stats (record, win%, games played, tournaments
// attended) and Glicko-2 power rankings across all tournament sources.
//
// Applies manual dedup/identity config from data/player-identities.json
// (alias merges + name-collision splits), and enriches output with
// data/player-info.json (city/state) and data/tournament-locations.json.
//
// Manual match enrichment: data/manual-matches.json
//
// Usage: node aggregate_players.js
// Writes:
//   data/players/players.csv
//   index.html / index.css / index.js (repo root)

'use strict';

const fs = require('fs');
const path = require('path');
const glicko2 = require('./glicko2');
const { resolveParticipantName } = require('../challonge/resolve_participant_name');
const { buildBracketData } = require('./build_bracket');

const DATA_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(__dirname, '..', '..');

// Inlined as data: URIs at build time rather than referenced by path -- a
// relative same-origin <img src> can silently fail to load if the page is
// ever opened as a local file:// URL instead of served over http(s), and
// (separately) the download feature's own image-inlining step can't fetch()
// a file:// resource at all. Baking them in removes the runtime dependency
// entirely, for both cases.
function assetDataUri(relativePath) {
  const buf = fs.readFileSync(path.join(REPO_ROOT, relativePath));
  return `data:image/png;base64,${buf.toString('base64')}`;
}

// --- Glicko-2 tuning constants ---
const GLICKO_DEFAULT_R = 1500;
const GLICKO_DEFAULT_RD = 350;
const GLICKO_DEFAULT_SIGMA = 0.06;
const GLICKO_RD_DECAY_PER_MONTH = 5;    // RD added (quadratically) per inactive month
const GLICKO_UNCERTAIN_RD_THRESHOLD = 150; // rows above this RD are dimmed
const GLICKO_CLOSE_GAME_SCORE = 0.86;   // win score for a game won by 1 goal  (3-2)
const GLICKO_NEAR_GAME_SCORE  = 0.94;   // win score for a game won by 2 goals (3-1)
const GLICKO_WITHIN_TOURNAMENT_PASSES = 4; // iterative passes per tournament to correct new-player bias
const GIANT_KILLER_GAP = 150;   // rating gap (opponent minus self) for a "giant killer" win / "upset victim" loss
const GIANT_KILLER_GAP_MAJOR = 200; // larger gap tier shown alongside the base one

// Location flag/abbreviation data (city flags, state/province flags, country
// flags, state name lookups) lives in data/location-flags.json for easy editing.
const locationFlags = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'location-flags.json'), 'utf8'));
const STATE_NAMES = locationFlags.stateNames;
const CITY_FLAGS = locationFlags.cityFlags;
const US_STATE_FLAGS = locationFlags.usStateFlags;
const CA_PROVINCE_FLAGS = locationFlags.caProvinceFlags;
const COUNTRY_CODES = locationFlags.countryCodes;
const STATE_ABBR_BY_NAME = Object.fromEntries(
  Object.entries(STATE_NAMES).map(([abbr, name]) => [name, abbr])
);

// Flag image URL helpers
const WIKIMEDIA_FLAG = (file) =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`;
const NIBSBIN_FLAG = (file) =>
  `https://cdn.jsdelivr.net/gh/nibsbin/us-state-flags-svg@master/flags/${encodeURIComponent(file)}`;
const FLAG_ICON_URL = (code) =>
  `https://cdn.jsdelivr.net/npm/flag-icons@7.5.0/flags/4x3/${code}.svg`;

function cityFlagUrl(entry) {
  return entry.url || WIKIMEDIA_FLAG(entry.file);
}

// Returns { src, title } for an <img> tag, or null if no location info.
function flagForInfo(info) {
  if (!info.city && !info.state && !info.country) return null;
  const country = info.country || 'United States';

  // 1. City flag
  if (info.city && info.state) {
    const entry = CITY_FLAGS[`${info.city}|${info.state}`];
    if (entry) return { src: cityFlagUrl(entry), title: info.city };
  }

  // 2. State / province flag
  if (info.state) {
    if (country === 'United States') {
      const file = US_STATE_FLAGS[info.state];
      if (file) return { src: NIBSBIN_FLAG(file), title: STATE_NAMES[info.state] || info.state };
    } else if (country === 'Canada') {
      const fullName = STATE_NAMES[info.state] || info.state;
      const file = CA_PROVINCE_FLAGS[fullName];
      if (file) return { src: WIKIMEDIA_FLAG(file), title: fullName };
    }
  }

  // 3. Country flag
  const countryEntry = COUNTRY_CODES[country];
  if (countryEntry) return { src: FLAG_ICON_URL(countryEntry.code), title: country };

  return null;
}

// Returns a 2-4 letter location abbreviation for display in the compact
// power-ranking cards, or '' if no location info.
function abbrevForInfo(info) {
  if (!info.city && !info.state && !info.country) return '';
  const country = info.country || 'United States';

  if (info.city && info.state) {
    const entry = CITY_FLAGS[`${info.city}|${info.state}`];
    if (entry) return entry.abbr;
  }

  if (info.state) return STATE_ABBR_BY_NAME[info.state] || info.state;

  const countryEntry = COUNTRY_CODES[country];
  if (countryEntry) return countryEntry.abbr;

  return '';
}

// Pre-projected US state / Canadian province outlines for the Map tab (see
// data/generate_map_shapes.js for how this is generated).
const mapShapes = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'map-shapes.json'), 'utf8'));

// The Map tab's default/reset viewBox, in map-shapes.json's coordinate
// space — hand-picked (not computed from the data) so the map always
// occupies the same amount of screen space regardless of which
// states/provinces currently have data. Framed to the contiguous US;
// deliberately crops off Ontario's northern reach toward Hudson Bay (its
// label still falls well within this box) since Ontario is the only
// Canadian province with any players/tournaments right now and its full
// shape is far taller than any US state's — including all of it would
// waste most of the frame on empty Arctic space. Re-tune by hand (see the
// preview-render workflow in this file's CLAUDE.md entry) if a future
// region's data needs more room.
const MAP_HOME_VIEWBOX = [35, 150, 685, 450];

// Normalizes a raw state value (a USPS/province abbreviation like "TX", or a
// full name like "Ontario" as used by some player-info.json/tournament-locations.json
// entries) to its abbreviation, for keying into mapShapes/STATE_NAMES.
function regionAbbr(raw) {
  if (!raw) return '';
  if (STATE_NAMES[raw]) return raw;
  return STATE_ABBR_BY_NAME[raw] || '';
}

// ---------------------------------

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const identities = readJson(path.join(DATA_ROOT, 'player-identities.json'), { aliases: [], splits: [], hidden: [] });
const hiddenNames = new Set((identities.hidden || []).map((n) => n.trim().toLowerCase()));
const playerInfo = readJson(path.join(DATA_ROOT, 'player-info.json'), { players: {} }).players || {};
// A player with no split/alias resolves to whatever casing was literally
// typed into that specific tournament's bracket (e.g. "spoom" vs. "Spoom"),
// which can differ across tournaments for the same real person — but
// player-info.json is keyed by a single canonical casing. An exact-case
// lookup then only succeeds for tournaments that happened to use that exact
// casing, silently dropping location/flag data everywhere else. Fall back to
// a case-insensitive index so lookup doesn't depend on which casing a given
// tournament host happened to type.
const playerInfoByLowerKey = new Map(Object.keys(playerInfo).map((k) => [k.toLowerCase(), playerInfo[k]]));
function lookupPlayerInfo(id, name) {
  return playerInfo[id] || playerInfo[name]
    || playerInfoByLowerKey.get((id || '').toLowerCase())
    || playerInfoByLowerKey.get((name || '').toLowerCase())
    || {};
}

// Shared by every doubles-card renderer (Doubles tab, player-page Doubles
// section) so a team's two names always carry their flags, same as any
// other player-name mention on the site.
function playerFlagImg(id, name) {
  const flag = flagForInfo(lookupPlayerInfo(id, name));
  return flag ? `<img class="loc-flag" src="${escapeHtml(flag.src)}" title="${escapeHtml(flag.title)}" alt="${escapeHtml(flag.title)}">` : '';
}
const tournamentLocations = readJson(path.join(DATA_ROOT, 'tournament-locations.json'), { locations: {} }).locations || {};
// Flat map of tournament URL -> group id, for collapsing a cluster of
// same-event tournaments (e.g. SGDQ 2024's several side brackets) into one
// point for rating-change/history purposes -- see groupIdFor() below.
const tournamentGroups = readJson(path.join(DATA_ROOT, 'tournament-groups.json'), {});
// Flat map of tournament URL -> true, for tournaments that were a doubles
// (2v2 team) format instead of standard singles -- see isDoublesTournament()
// below. Doubles tournaments still get their own page and show up in the
// Tournaments list (with a pill), but never feed the Glicko rating engine or
// a player's singles win/loss stats/rating history (see the isDoubles guards
// in processChronologically/buildPlayerHistories/buildPlayerStats); their
// results are only ever aggregated into team records for the Doubles tab
// (buildDoublesTeams).
const tournamentDoubles = readJson(path.join(DATA_ROOT, 'tournament-doubles.json'), {});
function isDoublesTournament(url) {
  return !!tournamentDoubles[url];
}

// Splits a doubles participant/team raw name (e.g. "PlayerA + PlayerB" or
// "PlayerA & PlayerB") into its two component raw player names. Returns
// null if the name doesn't contain exactly one such separator.
function parseTeamName(rawName) {
  const trimmed = normName(rawName);
  if (!trimmed) return null;
  const parts = trimmed.split(/\s*[+&]\s*/).map((s) => s.trim()).filter(Boolean);
  return parts.length === 2 ? parts : null;
}
// Manually maintained list for the "Upcoming Events" tab -- each entry is
// { date, link, city, state, location, name }, keyed by nothing (just an
// array) since these aren't cross-referenced against scraped tournament
// data the way tournament-locations.json entries are.
const upcomingEvents = readJson(path.join(DATA_ROOT, 'upcoming-events.json'), { events: [] }).events || [];

function normName(name) {
  return (name || '').trim();
}

// A tournament with no entry in tournament-groups.json is its own
// singleton group (keyed by its own URL), so ungrouped tournaments behave
// exactly as before -- one snapshot each.
function groupIdFor(url) {
  return tournamentGroups[url] || url;
}

function resolveIdentity(rawName, tournamentUrl) {
  const trimmed = normName(rawName);
  const lower = trimmed.toLowerCase();

  const split = (identities.splits || []).find((s) => normName(s.name).toLowerCase() === lower);
  if (split) {
    const resolution = (split.resolutions || []).find((r) => (r.tournaments || []).includes(tournamentUrl));
    if (resolution) return { id: resolution.id, name: resolution.canonical };
    if (split.default) return { id: split.default.id, name: split.default.canonical };
  }

  const alias = (identities.aliases || []).find((a) => (a.names || []).some((n) => normName(n).toLowerCase() === lower));
  if (alias) return { id: alias.id || alias.canonical.toLowerCase(), name: alias.canonical };

  return { id: lower, name: trimmed };
}

// The same green/purple accent used for a player's power-ranking card —
// an explicit color on file wins; otherwise a deterministic hash of their
// identity id keeps an unset player's accent stable across regenerations
// without us having to assign one.
function cardAccent(id, colorOverride) {
  if (colorOverride === 'green' || colorOverride === 'purple') return `card-${colorOverride}`;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return (h & 1) ? 'card-purple' : 'card-green';
}

// Doubles-card counterpart to cardAccent -- when both teammates land on the
// same accent (either the same explicit color override, or the same hash
// default), the team card just uses that; when they differ, picks between
// the two deterministically off the team's own pair key (not either
// player's id alone) so the same team always lands on the same accent
// across regenerations.
function teamCardAccent(a, b) {
  const accentA = cardAccent(a.id, lookupPlayerInfo(a.id, a.name).color);
  const accentB = cardAccent(b.id, lookupPlayerInfo(b.id, b.name).color);
  if (accentA === accentB) return accentA;
  const key = teamKeyFor(a.id, b.id);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return (h & 1) ? accentB : accentA;
}

// Resolves a raw in-tournament name to its canonical display name plus a
// flag image (if the player has location info on file), for display on
// tournament pages — standings, crosstable, round list, bracket viewer.
function resolveDisplayName(rawName, tournamentUrl) {
  const identity = resolveIdentity(rawName, tournamentUrl);
  const info = lookupPlayerInfo(identity.id, identity.name);
  return { id: identity.id, name: identity.name, flag: flagForInfo(info) };
}

// Maps identity id -> filename slug (players/<slug>.html), assigned once all
// players are known (see main()). Read by nameHtml/writeHtml/writeTournamentPages
// to link a player's name to their page; empty until assignPlayerSlugs runs.
let playerSlugById = new Map();

// prefix is '' when linking from a root-level page (index.html) or '../' when
// linking from one level deep (tournaments/*.html, players/*.html).
function playerHref(id, prefix) {
  const slug = playerSlugById.get(id);
  return slug ? `${prefix}players/${slug}.html` : null;
}

// Stats-only pass (no Glicko) — used by add_tournaments.js to build a
// registry of known players for dedup matching against newly fetched names.
function buildPlayerStats(allTournaments) {
  const players = new Map();
  for (const t of allTournaments) {
    if (t.isDoubles) continue;
    for (const m of t.matches) {
      if (!m.winnerName || !m.loserName) continue;
      recordMatch(players, m.winnerName, m.loserName, t.url, t.label);
    }
  }
  return players;
}

function getPlayer(map, identity) {
  if (!identity || !identity.id) return null;
  const key = identity.id;
  if (!map.has(key)) {
    map.set(key, {
      wins: 0, losses: 0, games: 0,
      tournaments: new Map(),
      nameCounts: new Map(),
      // Raw in-tournament spellings actually typed, keyed before alias/split
      // resolution — nameCounts (below) only ever holds the *resolved*
      // canonical name, so a player with an explicit alias merge (e.g.
      // "somewes" aliasing "wes"/"Westley"/"Wizley"/...) would otherwise
      // never have their real alternate spellings recorded anywhere; every
      // raw variant collapses to the same nameCounts key before it's counted.
      rawNames: new Map(),
    });
  }
  const player = map.get(key);
  player.nameCounts.set(identity.name, (player.nameCounts.get(identity.name) || 0) + 1);
  return player;
}

function displayName(player) {
  return [...player.nameCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Every distinct raw spelling a player has been seen under, most-used first
// — excludes anything that's just a case variant of their display name.
function aliasesUsed(player) {
  const nameLower = displayName(player).toLowerCase();
  const byLower = new Map();
  for (const [raw, count] of player.rawNames.entries()) {
    const lower = raw.toLowerCase();
    if (lower === nameLower) continue;
    const existing = byLower.get(lower);
    if (!existing || count > existing.count) byLower.set(lower, { raw, count });
  }
  return [...byLower.values()].sort((a, b) => b.count - a.count || a.raw.localeCompare(b.raw)).map((e) => e.raw);
}

function recordMatch(map, winnerRawName, loserRawName, tournamentUrl, tournamentLabel) {
  if (hiddenNames.has(normName(winnerRawName).toLowerCase()) || hiddenNames.has(normName(loserRawName).toLowerCase())) return;
  const winner = getPlayer(map, resolveIdentity(winnerRawName, tournamentUrl));
  const loser = getPlayer(map, resolveIdentity(loserRawName, tournamentUrl));
  if (!winner || !loser) return;
  const winnerRaw = normName(winnerRawName);
  const loserRaw = normName(loserRawName);
  winner.rawNames.set(winnerRaw, (winner.rawNames.get(winnerRaw) || 0) + 1);
  loser.rawNames.set(loserRaw, (loser.rawNames.get(loserRaw) || 0) + 1);
  winner.wins += 1;
  winner.games += 1;
  winner.tournaments.set(tournamentUrl, tournamentLabel);
  loser.losses += 1;
  loser.games += 1;
  loser.tournaments.set(tournamentUrl, tournamentLabel);
}

function formatLocation(loc) {
  if (!loc) return '';
  return [loc.location, [loc.city, loc.state].filter(Boolean).join(', ')].filter(Boolean).join(', ');
}

function resolveLocationInfo(url, builtIn) {
  return tournamentLocations[url] || builtIn;
}

// Structured version of formatLocation for display contexts that visually
// separate the venue from the city/state, plus the flag to show alongside
// it (keyed off the tournament's city by default; a `flag: { city, state }`
// override in tournament-locations.json can point the flag elsewhere
// without changing the displayed venue/city/state text).
function locationDisplay(loc) {
  if (!loc) return { venue: '', cityState: '', flag: null };
  const flagSource = loc.flag || loc;
  return {
    venue: loc.location || '',
    cityState: [loc.city, loc.state].filter(Boolean).join(', '),
    flag: flagForInfo({ city: flagSource.city, state: flagSource.state, country: flagSource.country || loc.country }),
  };
}

function locationHtml(disp) {
  if (!disp || (!disp.venue && !disp.cityState)) return '';
  const flagImg = disp.flag ? `<img class="loc-flag" src="${escapeHtml(disp.flag.src)}" title="${escapeHtml(disp.flag.title)}" alt="${escapeHtml(disp.flag.title)}">` : '';
  const venueSpan = disp.venue ? `<span class="loc-venue">${escapeHtml(disp.venue)}</span>` : '';
  const sep = disp.venue && disp.cityState ? '<span class="loc-sep">&middot;</span>' : '';
  const cityStateSpan = disp.cityState ? `<span class="loc-citystate">${escapeHtml(disp.cityState)}</span>` : '';
  return `${flagImg}${venueSpan}${sep}${cityStateSpan}`;
}

function resolveDate(url, builtIn) {
  return tournamentLocations[url]?.date || builtIn;
}

function resolveName(url, builtIn) {
  return tournamentLocations[url]?.name || builtIn;
}

// Returns months elapsed between two YYYY-MM-DD strings. Returns 0 if either is missing.
function monthsBetween(dateA, dateB) {
  if (!dateA || !dateB) return 0;
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()));
}

// Expand a match's score into arrays of Glicko result values [0,1] for winner and loser.
// Set counts: "3-1" → winner gets [1,1,1,0], loser gets [0,0,0,1]
// Games array: each game is a mini-match; close games (margin ≤1) use GLICKO_CLOSE_GAME_SCORE
function expandScore(match) {
  if (match.games) {
    const winnerResults = [];
    const loserResults = [];
    for (const { winnerGoals, loserGoals } of match.games) {
      const winnerWonGame = winnerGoals > loserGoals;
      const margin = Math.abs(winnerGoals - loserGoals);
      const winScore = margin <= 1 ? GLICKO_CLOSE_GAME_SCORE : margin <= 2 ? GLICKO_NEAR_GAME_SCORE : 1.0;
      winnerResults.push(winnerWonGame ? winScore : 1 - winScore);
      loserResults.push(winnerWonGame ? 1 - winScore : winScore);
    }
    return { winnerResults, loserResults };
  }

  const wins = match.winnerSets != null ? match.winnerSets : 1;
  const losses = match.loserSets != null ? match.loserSets : 0;
  return {
    winnerResults: [...Array(Math.max(wins, 1)).fill(1.0), ...Array(Math.max(losses, 0)).fill(0.0)],
    loserResults: [...Array(Math.max(wins, 1)).fill(0.0), ...Array(Math.max(losses, 0)).fill(1.0)],
  };
}

// --- Data collection ---

function collectChallonge() {
  const storePath = path.join(DATA_ROOT, 'challonge', 'tournaments.json');
  if (!fs.existsSync(storePath)) return [];
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const result = [];

  for (const [url, rec] of Object.entries(store)) {
    if (!rec.tournament) continue;
    const t = rec.tournament;
    const label = resolveName(url, t.name.trim());
    const nameById = new Map(t.participants.map((p) => [p.participant.id, resolveParticipantName(p.participant)]));
    // Group-stage matches (round-robin pools ahead of a playoff bracket)
    // reference a separate per-group participant id, mapped back to the
    // main participant via `group_player_ids` — without this, group-stage
    // matches can't be resolved to player names at all.
    for (const p of t.participants) {
      for (const gpid of p.participant.group_player_ids || []) {
        nameById.set(gpid, resolveParticipantName(p.participant));
      }
    }

    const matches = [];
    // Matches Challonge already knows the pairing for but hasn't been played
    // yet (state "open" = both sides known and ready, "pending" = waiting on
    // a not-yet-played prerequisite, sometimes with one side already known)
    // — kept separate from `matches` (which stays real-results-only for
    // standings/crosstable/etc.) so build_bracket.js can render the exact
    // upcoming bracket slots instead of guessing them from the last known
    // round's winners.
    const pendingMatches = [];
    for (const m of t.matches) {
      const mm = m.match;
      if (mm.winner_id && mm.loser_id) {
        // handled below as a real match
      } else if (mm.group_id == null && mm.round != null && mm.round !== 0
        && (mm.state === 'open' || mm.state === 'pending')
        && (mm.player1_id || mm.player2_id)) {
        pendingMatches.push({
          round: mm.round,
          order: mm.suggested_play_order != null ? mm.suggested_play_order : mm.id,
          player1Name: mm.player1_id ? (nameById.get(mm.player1_id) || null) : null,
          player2Name: mm.player2_id ? (nameById.get(mm.player2_id) || null) : null,
        });
      }
      if (!mm.winner_id || !mm.loser_id) continue;
      const winnerName = nameById.get(mm.winner_id);
      const loserName = nameById.get(mm.loser_id);
      if (!winnerName || !loserName) continue;

      const isDQ = mm.forfeited === true;

      let winnerSets = null;
      let loserSets = null;
      if (!isDQ && mm.scores_csv) {
        const raw = mm.scores_csv.split(',')[0]; // take first game entry
        const dashIdx = raw.indexOf('-');
        if (dashIdx > 0) {
          const p1Raw = parseInt(raw.slice(0, dashIdx), 10);
          const p2Raw = parseInt(raw.slice(dashIdx + 1), 10);
          if (!isNaN(p1Raw) && !isNaN(p2Raw)) {
            let p1Sets = p1Raw;
            let p2Sets = p2Raw;
            // "0-0" means untracked — fall back to 1-0
            if (p1Sets === p2Sets) {
              p1Sets = mm.winner_id === mm.player1_id ? 1 : 0;
              p2Sets = mm.winner_id === mm.player2_id ? 1 : 0;
            }
            winnerSets = mm.winner_id === mm.player1_id ? p1Sets : p2Sets;
            loserSets = mm.winner_id === mm.player1_id ? p2Sets : p1Sets;
          }
        }
      }

      matches.push({
        winnerName, loserName, winnerSets, loserSets, games: null, isDQ,
        identifier: String(mm.identifier || mm.id || ''),
        round: mm.round != null ? mm.round : null,
        order: mm.suggested_play_order != null ? mm.suggested_play_order : mm.id,
        groupId: mm.group_id != null ? mm.group_id : null,
        stageKind: mm.group_id != null ? 'pool' : 'bracket',
      });
    }

    const participantList = t.participants.map((p) => ({
      name: resolveParticipantName(p.participant),
      seed: p.participant.seed != null ? p.participant.seed : null,
      finalRank: p.participant.final_rank != null ? p.participant.final_rank : null,
    }));

    const locInfo = resolveLocationInfo(url, null);
    result.push({
      url,
      label,
      date: resolveDate(url, (t.started_at || t.created_at || '').slice(0, 10)),
      location: formatLocation(locInfo),
      locationDisplay: locationDisplay(locInfo),
      state: locInfo?.state || '',
      country: locInfo?.country || '',
      participants: t.participants.length,
      matchCount: matches.length,
      source: 'Challonge',
      tournamentType: t.tournament_type || null,
      isDoubles: isDoublesTournament(url),
      participantList,
      matches,
      pendingMatches,
    });
  }

  return result;
}

function collectStartgg() {
  const storePath = path.join(DATA_ROOT, 'start.gg', 'tournaments.json');
  if (!fs.existsSync(storePath)) return [];
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const result = [];

  for (const [url, rec] of Object.entries(store)) {
    if (!rec.entrants || !rec.sets) continue;
    const label = resolveName(url, rec.tournament.name.trim());
    const nameByEntrantId = new Map(rec.entrants.map((e) => [e.id, e.participants[0]?.gamerTag || e.name || undefined]));

    const matches = [];
    // Sets start.gg has already paired up (both slots resolved, or one slot
    // resolved and waiting on a prerequisite) but hasn't been played yet —
    // see the matching Challonge collection above for why this is kept
    // separate from `matches`.
    const pendingMatches = [];
    for (const s of rec.sets) {
      const setBracketType = s.phaseGroup?.bracketType;
      if (!s.winnerId && s.slots.length === 2 && s.round != null
        && setBracketType !== 'ROUND_ROBIN' && setBracketType !== 'SWISS'
        && s.slots.some((sl) => sl.entrant)) {
        const [slot1, slot2] = s.slots;
        pendingMatches.push({
          round: s.round,
          order: s.id,
          player1Name: slot1?.entrant ? (nameByEntrantId.get(slot1.entrant.id) || null) : null,
          player2Name: slot2?.entrant ? (nameByEntrantId.get(slot2.entrant.id) || null) : null,
        });
      }
      if (!s.winnerId || s.slots.length !== 2 || !s.slots.every((sl) => sl.entrant)) continue;
      const loserSlot = s.slots.find((sl) => sl.entrant.id !== s.winnerId);
      if (!loserSlot) continue;
      const winnerName = nameByEntrantId.get(s.winnerId);
      const loserName = nameByEntrantId.get(loserSlot.entrant.id);
      if (!winnerName || !loserName) continue;

      const winnerSlot = s.slots.find((sl) => sl.entrant.id === s.winnerId);
      const winnerRaw = winnerSlot?.standing?.stats?.score?.value;
      const loserRaw = loserSlot?.standing?.stats?.score?.value;
      const isDQ = loserRaw === -1;

      const winnerSets = !isDQ && winnerRaw != null && winnerRaw >= 0 ? winnerRaw : null;
      const loserSets = !isDQ && loserRaw != null && loserRaw >= 0 ? loserRaw : null;

      const bracketType = s.phaseGroup?.bracketType;
      matches.push({
        winnerName, loserName, winnerSets, loserSets, games: null, isDQ,
        identifier: s.identifier || String(s.id || ''),
        round: s.round != null ? s.round : null,
        order: s.id,
        groupId: s.phaseGroup?.id != null ? s.phaseGroup.id : null,
        stageKind: bracketType === 'ROUND_ROBIN' || bracketType === 'SWISS' ? 'pool' : 'bracket',
      });
    }

    const participantList = rec.entrants.map((e) => ({
      name: e.participants[0]?.gamerTag || e.name || undefined,
      seed: e.seeds?.[0]?.seedNum != null ? e.seeds[0].seedNum : null,
      finalRank: null,
    })).filter((p) => p.name);

    const locInfo = resolveLocationInfo(url, { city: rec.tournament.city, state: rec.tournament.addrState });
    result.push({
      url,
      label,
      date: resolveDate(url, rec.tournament.startAt ? new Date(rec.tournament.startAt * 1000).toISOString().slice(0, 10) : ''),
      location: formatLocation(locInfo),
      locationDisplay: locationDisplay(locInfo),
      state: locInfo?.state || '',
      country: locInfo?.country || '',
      participants: rec.entrants.length,
      matchCount: matches.length,
      source: 'start.gg',
      tournamentType: null,
      isDoubles: isDoublesTournament(url),
      participantList,
      matches,
      pendingMatches,
    });
  }

  return result;
}

// Windows reserves these device names for any file whose base name matches,
// regardless of extension (CON.html still resolves to the console device for
// native Win32 APIs like git.exe) — Node's fs can create such a file via its
// own path handling, but git and other Win32 tools then fail to open it.
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

function slugify(s) {
  const slug = (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return WINDOWS_RESERVED_NAMES.has(slug) ? `${slug}-player` : slug;
}

// Assigns a unique, filesystem-safe slug to each tournament (name + date),
// used for its standalone bracket page filename.
function assignSlugs(allTournaments) {
  const used = new Set();
  for (const t of allTournaments) {
    const base = `${slugify(t.label)}-${t.date || 'unknown'}`;
    let slug = base;
    let n = 1;
    while (used.has(slug)) slug = `${base}-${++n}`;
    used.add(slug);
    t.slug = slug;
  }
}

// Splits a tournament into its constituent stages (e.g. round-robin group
// pools followed by a single/double-elimination playoff bracket), based on
// each match's `groupId` (Challonge's match.group_id, or start.gg's
// phaseGroup id). Tournaments with only one distinct groupId (the vast
// majority) come back as a single unlabeled stage — identical to the
// pre-split behaviour. Each stage is a shallow clone of `t` scoped to that
// stage's matches/participants, so existing per-tournament builders
// (buildStandings, buildRoundGroups, buildCrosstable, buildBracketData) work
// on it unmodified.
function splitStages(t) {
  const groupIds = [...new Set(t.matches.map((m) => (m.groupId != null ? m.groupId : null)))];
  if (groupIds.length <= 1) return [{ label: null, tLike: t }];

  // Pool groups (round-robin/swiss) first, in first-seen order; the
  // playoff/bracket group (Challonge: groupId null) last.
  const poolIds = groupIds.filter((id) => id != null).sort((a, b) => {
    const orderOf = (id) => Math.min(...t.matches.filter((m) => m.groupId === id).map((m) => m.order != null ? m.order : 0));
    return orderOf(a) - orderOf(b);
  });
  const hasBracketGroup = groupIds.includes(null);
  const orderedIds = hasBracketGroup ? [...poolIds, null] : poolIds;

  return orderedIds.map((groupId, i) => {
    const stageMatches = t.matches.filter((m) => (m.groupId != null ? m.groupId : null) === groupId);
    const isBracketStage = groupId === null || stageMatches.every((m) => m.stageKind === 'bracket');
    const stageNames = new Set(stageMatches.flatMap((m) => [m.winnerName, m.loserName]).filter(Boolean));
    const stageParticipantList = t.participantList.filter((p) => stageNames.has(p.name));
    return {
      label: isBracketStage && hasBracketGroup ? 'Playoff Bracket' : poolIds.length > 1 ? `Group ${i + 1}` : 'Group Stage',
      tLike: {
        ...t,
        tournamentType: isBracketStage ? t.tournamentType : 'round robin',
        matches: stageMatches,
        participantList: stageParticipantList,
      },
    };
  });
}

// Standings for a tournament: prefer Challonge's own final_rank when most
// participants have one, otherwise derive placement from elimination order
// (each player's rank is driven by the `order` of the last match they lost —
// later elimination = better placement — with the winner of the
// highest-`order` match as champion). This avoids needing to model
// winners/losers bracket topology explicitly.
// Derives standings from a successfully-reconstructed bracket (see
// build_bracket.js) instead of raw match-order heuristics — the source
// platforms' `id`/order fields aren't reliably chronological (start.gg in
// particular assigns set ids in bracket-creation order, not play order), but
// our reconstruction's own group/round structure is correct by construction,
// since every one of its matches was validated against real results.
function deriveStandingsFromBracket(bracketData) {
  const nameById = new Map(bracketData.participants.map((p) => [p.id, p.name]));
  const sorted = [...bracketData.matches].sort((a, b) => a.group_id - b.group_id || a.round_id - b.round_id || a.number - b.number);

  // Bracket placement is a per-round notion: everyone knocked out in the
  // same round shares a placement (tied 5th, tied 7th — and tied 3rd in
  // single elim, where the semifinal losers never play each other). So
  // placements are computed from a dense per-round index in progression
  // order, not a per-match sequence number (which made every elimination
  // artificially unique and produced no ties at all).
  const roundIdx = new Map();
  for (const m of sorted) {
    const key = m.group_id + ':' + m.round_id;
    if (!roundIdx.has(key)) roundIdx.set(key, roundIdx.size);
  }

  // lastLoss: the round a player was last defeated in. lastSeen: the round
  // they last appeared in at all, *including* pending (not-yet-played)
  // matches — so in an unfinished bracket, a player awaiting their next
  // match counts as still alive rather than eliminated where they last
  // lost, and an undefeated player stuck mid-bracket isn't dumped to the
  // bottom for having no loss to sort by.
  const lastLoss = new Map();
  const lastSeen = new Map();
  for (const m of sorted) {
    const idx = roundIdx.get(m.group_id + ':' + m.round_id);
    for (const o of [m.opponent1, m.opponent2]) {
      if (o && o.id != null) lastSeen.set(o.id, Math.max(lastSeen.get(o.id) ?? -1, idx));
    }
    if (!m.opponent1 || !m.opponent2 || m.opponent1.id == null || m.opponent2.id == null) continue;
    if (m.opponent1.result !== 'win' && m.opponent2.result !== 'win') continue; // pending
    const loserId = m.opponent1.result === 'win' ? m.opponent2.id : m.opponent1.id;
    lastLoss.set(loserId, Math.max(lastLoss.get(loserId) ?? -1, idx));
  }

  // Placement score, higher = better. Eliminated players score the round
  // that eliminated them (their *last* loss — a winners-bracket loss
  // doesn't eliminate in double elim, and the losers-bracket loss that
  // does comes later in progression order). Anyone alive past round k —
  // a completed bracket's champion included, being "alive" past the final
  // — outranks everyone eliminated in round k via the +0.5.
  const score = (id) => {
    const seen = lastSeen.get(id) ?? -1;
    const loss = lastLoss.get(id) ?? -1;
    return loss >= seen ? loss : seen + 0.5;
  };

  const ordered = [...bracketData.participants].sort((a, b) => score(b.id) - score(a.id));
  const rows = [];
  for (let i = 0; i < ordered.length; i++) {
    const rank = i > 0 && score(ordered[i].id) === score(ordered[i - 1].id) ? rows[i - 1].rank : i + 1;
    rows.push({ name: nameById.get(ordered[i].id), rank });
  }
  return rows;
}

// Ranks by elimination order: each player's rank is driven by the `order` of
// the last match they lost — later elimination = better placement — with
// the winner of the highest-`order` match as champion. Used as a fallback
// when there's no successfully-reconstructed bracket to derive order from.
function rankByEliminationOrder(matches, names) {
  const lastLossOrder = new Map();
  let maxOrder = -Infinity;
  let champion = null;
  for (const m of matches) {
    if (m.order == null) continue;
    if (m.loserName) lastLossOrder.set(m.loserName, Math.max(lastLossOrder.get(m.loserName) != null ? lastLossOrder.get(m.loserName) : -Infinity, m.order));
    if (m.winnerName && m.order > maxOrder) { maxOrder = m.order; champion = m.winnerName; }
  }
  const rest = names.filter((n) => n !== champion);
  rest.sort((a, b) => {
    const oa = lastLossOrder.has(a) ? lastLossOrder.get(a) : -Infinity;
    const ob = lastLossOrder.has(b) ? lastLossOrder.get(b) : -Infinity;
    return ob - oa;
  });
  const ordered = champion ? [champion, ...rest] : rest;
  return ordered.map((name, i) => ({ name, rank: i + 1 }));
}

// Ranks names that never reached the final stage by combined pool-stage
// win rate (across every pool group they played in), best first.
function rankByPoolRecord(poolMatches, names) {
  const stats = new Map(names.map((n) => [n, { w: 0, l: 0 }]));
  for (const m of poolMatches) {
    if (stats.has(m.winnerName)) stats.get(m.winnerName).w++;
    if (stats.has(m.loserName)) stats.get(m.loserName).l++;
  }
  return [...names].sort((a, b) => {
    const sa = stats.get(a);
    const sb = stats.get(b);
    const wpA = sa.w + sa.l > 0 ? sa.w / (sa.w + sa.l) : 0;
    const wpB = sb.w + sb.l > 0 ? sb.w / (sb.w + sb.l) : 0;
    if (wpB !== wpA) return wpB - wpA;
    return sb.w - sa.w;
  });
}

// Standings for a tournament: prefer Challonge's own final_rank when most
// participants have one; otherwise derive placement ourselves. The same
// real person can appear under more than one raw name within a single
// tournament (e.g. Challonge auto-suffixes a second registration — "Wes" /
// "Wes2" — when someone plays an extra/makeup round), so identities are
// canonicalized (via the same alias/split resolution used for global player
// stats) before ranking, merging their combined record into one slot.
//
// For tournaments with a group/pool stage feeding into a playoff bracket,
// reaching the bracket outranks any amount of pool-stage success — those
// participants are ranked first (by bracket placement), everyone eliminated
// in pools ranked after (by combined pool win rate).
function buildStandings(t) {
  const named = t.participantList.filter((p) => p.name);
  const canon = (rawName) => resolveIdentity(rawName, t.url).name;
  const canonicalMatches = t.matches.map((m) => ({
    ...m,
    winnerName: m.winnerName ? canon(m.winnerName) : m.winnerName,
    loserName: m.loserName ? canon(m.loserName) : m.loserName,
  }));

  // Overall W-L record (across every stage of the tournament), attached to
  // every standings row regardless of which ranking method produced it.
  const wlRecord = new Map();
  for (const m of canonicalMatches) {
    if (!m.winnerName || !m.loserName) continue;
    if (!wlRecord.has(m.winnerName)) wlRecord.set(m.winnerName, { wins: 0, losses: 0 });
    if (!wlRecord.has(m.loserName)) wlRecord.set(m.loserName, { wins: 0, losses: 0 });
    wlRecord.get(m.winnerName).wins++;
    wlRecord.get(m.loserName).losses++;
  }
  const withRecord = (rows) => rows.map((r) => ({
    ...r,
    wins: wlRecord.get(r.name)?.wins || 0,
    losses: wlRecord.get(r.name)?.losses || 0,
  }));

  const hasOfficialRanks = t.source === 'Challonge' &&
    named.filter((p) => p.finalRank != null).length >= named.length * 0.8;

  if (hasOfficialRanks) {
    const byCanonical = new Map();
    for (const p of named) {
      const name = canon(p.name);
      const existing = byCanonical.get(name);
      if (!existing || (p.finalRank != null && (existing.finalRank == null || p.finalRank < existing.finalRank))) {
        byCanonical.set(name, { name, finalRank: p.finalRank != null ? p.finalRank : existing?.finalRank ?? null, seed: p.seed });
      }
    }
    return withRecord([...byCanonical.values()]
      .sort((a, b) => {
        const ar = a.finalRank != null ? a.finalRank : Infinity;
        const br = b.finalRank != null ? b.finalRank : Infinity;
        if (ar !== br) return ar - br;
        return (a.seed != null ? a.seed : Infinity) - (b.seed != null ? b.seed : Infinity);
      })
      .map((p) => ({ name: p.name, rank: p.finalRank })));
  }

  const canonicalNames = [...new Set(named.map((p) => canon(p.name)))];

  const finalStage = t.stages && t.stages.length > 1 ? t.stages[t.stages.length - 1] : null;
  const finalStageIsBracket = finalStage && finalStage.tLike.matches.length > 0 && finalStage.tLike.matches.every((m) => m.stageKind === 'bracket');

  if (finalStageIsBracket) {
    const finalNames = new Set(finalStage.tLike.participantList.map((p) => canon(p.name)));
    const finalRanked = finalStage.bracketData
      ? deriveStandingsFromBracket(finalStage.bracketData)
      : rankByEliminationOrder(canonicalMatches.filter((m) => m.stageKind === 'bracket'), [...finalNames]);

    const poolNames = canonicalNames.filter((n) => !finalNames.has(n));
    const poolMatches = canonicalMatches.filter((m) => m.stageKind === 'pool');
    const poolRanked = rankByPoolRecord(poolMatches, poolNames);

    return withRecord([
      // Bracket placements come through as-is (they can contain ties); pool
      // eliminees rank after every bracket participant, so their numbering
      // starts at the bracket's participant *count* + 1 regardless of ties.
      ...finalRanked.map((r) => ({ name: r.name, rank: r.rank })),
      ...poolRanked.map((name, i) => ({ name, rank: finalRanked.length + i + 1 })),
    ]);
  }

  if (t.stages && t.stages.length === 1 && t.stages[0].bracketData) {
    return withRecord(deriveStandingsFromBracket(t.stages[0].bracketData));
  }

  // Elimination order (last-loss order) only makes sense for a bracket —
  // a round-robin/swiss stage has no eliminations to order by, so rank by
  // win record instead (this also drives the crosstable's row/column order,
  // since it's built from these standings).
  if (t.tournamentType === 'round robin' || t.tournamentType === 'swiss') {
    return withRecord(rankByPoolRecord(canonicalMatches, canonicalNames).map((name, i) => ({ name, rank: i + 1 })));
  }

  return withRecord(rankByEliminationOrder(canonicalMatches, canonicalNames));
}

// Groups a tournament's matches by round for bracket display, ordered
// Winners Round 1..N then Losers Round 1..N (negative round = losers side).
function buildRoundGroups(t) {
  const hasLosers = t.matches.some((m) => m.round != null && m.round < 0);
  const groups = new Map();
  for (const m of t.matches) {
    const key = m.round != null ? m.round : 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === 'other') return 1;
    if (b === 'other') return -1;
    const aLoser = a < 0 ? 1 : 0;
    const bLoser = b < 0 ? 1 : 0;
    if (aLoser !== bLoser) return aLoser - bLoser;
    return Math.abs(a) - Math.abs(b);
  });
  return keys.map((key) => {
    const label = key === 'other' ? 'Other Matches' : key < 0 ? `Losers Round ${Math.abs(key)}` : hasLosers ? `Winners Round ${key}` : `Round ${key}`;
    const matches = [...groups.get(key)].sort((a, b) => (a.order != null ? a.order : 0) - (b.order != null ? b.order : 0));
    return { label, matches };
  });
}

// Builds a head-to-head results grid for round-robin/swiss tournaments:
// one row+column per player (ordered by standings), each cell showing the
// result of that pairing (W/L, or D on a split double-round-robin).
function buildCrosstable(t, standings) {
  // `standings` names are canonicalized (aliases/splits resolved) — a
  // player's raw matches must be canonicalized the same way, or a player
  // with an alias (e.g. someone who played an extra group-stage round under
  // a second Challonge registration) would have their real matches silently
  // fail to look up against their canonical row/column header.
  const canon = (rawName) => resolveIdentity(rawName, t.url).name;
  const names = standings.length ? standings.map((s) => s.name) : [...new Set(t.matches.flatMap((m) => [m.winnerName, m.loserName]).filter(Boolean).map(canon))];

  const pairKey = (a, b) => [a, b].sort().join(' ');
  const byPair = new Map();
  for (const m of t.matches) {
    if (!m.winnerName || !m.loserName) continue;
    const key = pairKey(canon(m.winnerName), canon(m.loserName));
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(m);
  }

  function cell(a, b) {
    if (a === b) return null;
    const matches = byPair.get(pairKey(a, b));
    if (!matches || matches.length === 0) return { empty: true };
    let winsA = 0;
    let winsB = 0;
    for (const m of matches) {
      if (canon(m.winnerName) === a) winsA++;
      else if (canon(m.winnerName) === b) winsB++;
    }
    const label = winsA > winsB ? 'W' : winsA < winsB ? 'L' : 'D';
    return { label, title: `${winsA}-${winsB}` };
  }

  return { names, cell };
}

// Converts a raw manual-matches.json entry into a normalised match object.
function resolveManualMatch(m) {
  if (m.games) {
    let p1Wins = 0;
    let p2Wins = 0;
    const parsed = m.games.map((g) => {
      const [p1Goals, p2Goals] = g.split('-').map(Number);
      if (p1Goals > p2Goals) p1Wins++;
      else p2Wins++;
      return { p1Goals, p2Goals };
    });

    if (p1Wins === p2Wins) {
      console.warn(`Manual match: tied game count in games array (p1=${m.p1}, p2=${m.p2}), defaulting p1 as winner`);
      p1Wins++;
    }

    const p1IsWinner = p1Wins > p2Wins;
    // Normalise all game scores to winner-first perspective
    const games = parsed.map(({ p1Goals, p2Goals }) => ({
      winnerGoals: p1IsWinner ? p1Goals : p2Goals,
      loserGoals: p1IsWinner ? p2Goals : p1Goals,
    }));

    return {
      winnerName: p1IsWinner ? m.p1 : m.p2,
      loserName: p1IsWinner ? m.p2 : m.p1,
      // The games-won tally (e.g. 2-1), not a goal score — this is what
      // every other match on the page shows as its "score", and what
      // build_bracket.js displays on the bracket card. It duplicates what
      // matchScoreLabel() derives from `games` for the round-list view, but
      // that function can't help build_bracket.js, which only ever reads
      // winnerSets/loserSets and otherwise silently defaults to 1-0.
      winnerSets: p1IsWinner ? p1Wins : p2Wins,
      loserSets: p1IsWinner ? p2Wins : p1Wins,
      games,
      isDQ: false,
    };
  }

  if (m.score) {
    const [a, b] = m.score.split('-').map(Number);
    if (a === b) console.warn(`Manual match: tied score "${m.score}" (p1=${m.p1}, p2=${m.p2}), defaulting p1 as winner`);
    const p1IsWinner = a >= b;
    return {
      winnerName: p1IsWinner ? m.p1 : m.p2,
      loserName: p1IsWinner ? m.p2 : m.p1,
      winnerSets: p1IsWinner ? a : b,
      loserSets: p1IsWinner ? b : a,
      games: null,
      isDQ: false,
    };
  }

  // No score provided — treat as a plain win for p1
  return {
    winnerName: m.p1,
    loserName: m.p2,
    winnerSets: 1,
    loserSets: 0,
    games: null,
    isDQ: false,
  };
}

// Returns Map<tournamentUrl, normalised match[]> for known URLs only.
function loadManualMatches(knownUrls) {
  const raw = readJson(path.join(DATA_ROOT, 'manual-matches.json'), { matches: [] }).matches || [];
  const byUrl = new Map();
  for (const m of raw) {
    if (!m.tournament) { console.warn('Manual match missing tournament URL, skipping'); continue; }
    if (!knownUrls.has(m.tournament)) {
      console.warn(`Manual match references unknown tournament: ${m.tournament}`);
      continue;
    }
    if (!byUrl.has(m.tournament)) byUrl.set(m.tournament, []);
    byUrl.get(m.tournament).push({ ...resolveManualMatch(m), matchIndex: m.match_index || null });
  }
  return byUrl;
}

// --- Core processing ---

// Processes all tournaments in chronological order, building both the player
// stats map (for the Players tab) and the Glicko state map (for Rankings).
//
// Each tournament runs GLICKO_WITHIN_TOURNAMENT_PASSES iterations. Each pass
// uses the previous pass's rating estimates as opponent strength references,
// while keeping each player's own historical prior (originalPreStates) as the
// starting point for their update. This corrects new-player bias within an
// event without using any information from future tournaments.
// preTournamentRatings, if passed, is filled with Map<tournamentUrl,
// Map<playerId, glickoState>> — each player's rating as they entered that
// tournament, before any of its matches were applied. Used to answer
// "what was this opponent rated at the time of the match" (e.g. a
// player's best win) without conflating it with their current rating.
// snapshots, if passed, is filled with one entry per tournament (in
// chronological order): { url, date, participantIds: Set<playerId>,
// ratings: Map<playerId, glickoState>, stats: Map<playerId, { wins, losses,
// games }> }. ratings/stats are full clones of the glicko/players maps as
// they stood right after that tournament's results were locked in — i.e.
// every player's rating and cumulative record as of that point in history,
// not just this tournament's participants — so the whole field's standings
// at that moment in time can be reconstructed later (see groupCheckpoints in
// main(), which powers the Rankings tab's "View rankings at" time-travel
// dropdown). participantIds marks who actually played this specific
// tournament (ratings/stats alone can't tell you that, since they carry
// everyone's running total). Tournament grouping (groupIdFor/tournament-
// groups.json) deliberately has no bearing here — it only affects which
// prior snapshot the Rankings tab's up/down badge compares against (see
// previousRanks in main()), not the per-tournament snapshot list itself,
// so it can't leak into anything keyed off snapshots (the rating-history
// chart on player pages, rank-at-the-time, etc).
function processChronologically(allTournaments, players, glicko, preTournamentRatings, snapshots) {
  for (const tournament of allTournaments) {
    // Doubles tournaments never touch the Glicko engine or singles W/L
    // stats -- see buildDoublesTeams for where their results actually go.
    if (tournament.isDoubles) continue;
    // Compute pre-tournament states with lazy decay — fixed across all passes.
    const originalPreStates = new Map();
    for (const match of tournament.matches) {
      for (const rawName of [match.winnerName, match.loserName]) {
        if (!rawName) continue;
        if (hiddenNames.has(normName(rawName).toLowerCase())) continue;
        const identity = resolveIdentity(rawName, tournament.url);
        if (!identity || !identity.id) continue;
        if (originalPreStates.has(identity.id)) continue;
        const current = glicko.get(identity.id) || { r: GLICKO_DEFAULT_R, rd: GLICKO_DEFAULT_RD, sigma: GLICKO_DEFAULT_SIGMA, lastActiveDate: null };
        const months = monthsBetween(current.lastActiveDate, tournament.date);
        originalPreStates.set(identity.id, glicko2.decayRd(current, months, GLICKO_RD_DECAY_PER_MONTH, GLICKO_DEFAULT_RD));
      }
    }
    if (preTournamentRatings) preTournamentRatings.set(tournament.url, new Map(originalPreStates));

    // Opponent estimates start at originalPreStates and improve each pass.
    let currentStates = new Map(originalPreStates);

    for (let pass = 0; pass < GLICKO_WITHIN_TOURNAMENT_PASSES; pass++) {
      const periodResults = new Map();

      for (const match of tournament.matches) {
        const { winnerName, loserName, isDQ } = match;
        if (!winnerName || !loserName) continue;

        // W/L stats only on the first pass to avoid double-counting.
        if (pass === 0) recordMatch(players, winnerName, loserName, tournament.url, tournament.label);

        if (isDQ) continue;
        if (hiddenNames.has(normName(winnerName).toLowerCase()) || hiddenNames.has(normName(loserName).toLowerCase())) continue;

        const winnerId = resolveIdentity(winnerName, tournament.url).id;
        const loserId = resolveIdentity(loserName, tournament.url).id;
        // Use currentStates for opponent strength — this is what improves each pass.
        const winnerState = currentStates.get(winnerId);
        const loserState = currentStates.get(loserId);
        if (!winnerState || !loserState) continue;

        const { winnerResults, loserResults } = expandScore(match);

        if (!periodResults.has(winnerId)) periodResults.set(winnerId, []);
        if (!periodResults.has(loserId)) periodResults.set(loserId, []);

        for (const score of winnerResults) {
          periodResults.get(winnerId).push({ r: loserState.r, rd: loserState.rd, score });
        }
        for (const score of loserResults) {
          periodResults.get(loserId).push({ r: winnerState.r, rd: winnerState.rd, score });
        }
      }

      // Apply Glicko update. Each player's own prior is always originalPreStates
      // (anchored to history); only the opponent estimates (from currentStates) vary.
      const nextStates = new Map(currentStates);
      for (const [id, results] of periodResults) {
        if (!results.length) continue;
        const preState = originalPreStates.get(id);
        if (!preState) continue;
        const updated = glicko2.updatePeriod(preState, results);
        nextStates.set(id, { ...updated, lastActiveDate: tournament.date || preState.lastActiveDate });
      }
      currentStates = nextStates;
    }

    // Lock in converged ratings for this tournament's participants.
    for (const id of originalPreStates.keys()) {
      glicko.set(id, currentStates.get(id));
    }

    if (snapshots) {
      snapshots.push({
        url: tournament.url,
        date: tournament.date,
        label: tournament.label,
        slug: tournament.slug,
        participantIds: new Set(originalPreStates.keys()),
        ratings: new Map(glicko),
        // Cumulative wins/losses/games for every player known so far, as of
        // right after this tournament's matches were recorded (pass 0 of the
        // loop above already applied them to `players`) -- lets a historical
        // checkpoint (see groupCheckpoints in main()) reconstruct the full
        // ranking-card stat line, not just the rating.
        stats: new Map([...players.entries()].map(([id, p]) => [id, { wins: p.wins, losses: p.losses, games: p.games }])),
      });
    }
  }
}

// Assigns a unique, filesystem-safe slug (players/<slug>.html) to every known
// player id, keyed off their display name — mirrors assignSlugs() for
// tournaments. Must run before nameHtml()/writeHtml()/writeTournamentPages()
// are called, since they all read playerSlugById via playerHref().
function assignPlayerSlugs(players) {
  const used = new Set();
  for (const [id, p] of players.entries()) {
    const base = slugify(displayName(p)) || 'player';
    let slug = base;
    let n = 1;
    while (used.has(slug)) slug = `${base}-${++n}`;
    used.add(slug);
    playerSlugById.set(id, slug);
  }
}

// Per-player match log + tournament placement history, built from the fully
// resolved/merged/filtered tournament set (post manual-match merge, post
// hidden-name filtering). Powers the player pages: recent form, head-to-head
// records, goal(stock) differential, and full tournament history.
//
// Returns Map<id, { matches: [...], placements: [...] }> where:
//   matches:    one entry per match this player was in, newest last —
//               { opponentId, opponentName, won, isDQ, stocksFor, stocksAgainst,
//                 date, tournamentUrl, tournamentSlug, tournamentLabel }
//   placements: one entry per tournament entered, newest last —
//               { url, slug, label, date, rank, totalEntrants, wins, losses }
//               — plus, for a doubles tournament only, isDoubles/partnerId/
//               partnerName (the team's own rank/record in that event; see
//               the isDoubles branch below). Doubles tournaments only ever
//               contribute a placement, never a match -- see the isDoubles
//               guards in processChronologically/buildPlayerStats and
//               buildDoublesHistories for where the rest of their results go.
function buildPlayerHistories(allTournaments, preTournamentRatings) {
  const histories = new Map();
  const ensure = (id) => {
    if (!histories.has(id)) histories.set(id, { matches: [], placements: [] });
    return histories.get(id);
  };

  for (const t of allTournaments) {
    const standings = buildStandings(t);

    if (t.isDoubles) {
      const pairsByCanonName = resolveDoublesTeamPairs(t);
      for (const s of standings) {
        const pair = pairsByCanonName.get(s.name);
        if (!pair) continue;
        const [a, b] = pair;
        for (const [self, partner] of [[a, b], [b, a]]) {
          ensure(self.id).placements.push({
            url: t.url, slug: t.slug, label: t.label, date: t.date, flag: t.locationDisplay.flag,
            rank: s.rank, totalEntrants: standings.length, wins: s.wins, losses: s.losses,
            isDoubles: true, partnerId: partner.id, partnerName: partner.name,
          });
        }
      }
      continue;
    }

    const idByCanonName = new Map();
    for (const p of t.participantList) {
      if (!p.name) continue;
      const identity = resolveIdentity(p.name, t.url);
      idByCanonName.set(identity.name, identity.id);
    }
    for (const m of t.matches) {
      for (const raw of [m.winnerName, m.loserName]) {
        if (!raw) continue;
        const identity = resolveIdentity(raw, t.url);
        if (!idByCanonName.has(identity.name)) idByCanonName.set(identity.name, identity.id);
      }
    }

    for (const s of standings) {
      const id = idByCanonName.get(s.name);
      if (!id) continue;
      ensure(id).placements.push({
        url: t.url, slug: t.slug, label: t.label, date: t.date, flag: t.locationDisplay.flag,
        rank: s.rank, totalEntrants: standings.length, wins: s.wins, losses: s.losses,
      });
    }

    for (const m of t.matches) {
      if (!m.winnerName || !m.loserName) continue;
      const winner = resolveIdentity(m.winnerName, t.url);
      const loser = resolveIdentity(m.loserName, t.url);
      if (!winner.id || !loser.id) continue;
      // A manual match with real per-game goal scores (m.games) overrides the
      // games-won tally (winnerSets/loserSets) for goal totals — winnerSets/
      // loserSets is just a 2-1-style set score, not actual goals scored, so
      // it undercounts whenever the real per-game numbers are on file.
      let winnerGoals;
      let loserGoals;
      if (m.games && m.games.length) {
        winnerGoals = m.games.reduce((sum, g) => sum + g.winnerGoals, 0);
        loserGoals = m.games.reduce((sum, g) => sum + g.loserGoals, 0);
      } else {
        winnerGoals = m.winnerSets != null ? m.winnerSets : 1;
        loserGoals = m.loserSets != null ? m.loserSets : 0;
      }
      const winnerSets = m.winnerSets != null ? m.winnerSets : 1;
      const loserSets = m.loserSets != null ? m.loserSets : 0;
      // order carries the source platform's play-order/id for this match —
      // date alone ties every match in the same tournament together, so this
      // is needed as a same-day tiebreaker for "most recent match" ordering.
      const shared = { date: t.date, order: m.order != null ? m.order : 0, tournamentUrl: t.url, tournamentSlug: t.slug, tournamentLabel: t.label, isDQ: m.isDQ };
      // Both sides' pre-tournament rating (held constant across the whole
      // event, same as opponentRatingAtMatch) — own rating alongside the
      // opponent's lets a match's rating gap be computed later (giant-killer
      // wins / upset-victim losses), not just "who was this opponent."
      const ratingsForT = preTournamentRatings ? preTournamentRatings.get(t.url) : null;
      const winnerOwnRating = ratingsForT ? ratingsForT.get(winner.id)?.r : null;
      const loserOwnRating = ratingsForT ? ratingsForT.get(loser.id)?.r : null;
      ensure(winner.id).matches.push({ ...shared, opponentId: loser.id, opponentName: loser.name, won: true, stocksFor: winnerGoals, stocksAgainst: loserGoals, scoreFor: winnerSets, scoreAgainst: loserSets, opponentRatingAtMatch: loserOwnRating ?? null, ownRatingAtMatch: winnerOwnRating ?? null });
      ensure(loser.id).matches.push({ ...shared, opponentId: winner.id, opponentName: winner.name, won: false, stocksFor: loserGoals, stocksAgainst: winnerGoals, scoreFor: loserSets, scoreAgainst: winnerSets, opponentRatingAtMatch: winnerOwnRating ?? null, ownRatingAtMatch: loserOwnRating ?? null });
    }
  }

  return histories;
}

// Head-to-head breakdown from a player's match log: opponent totals plus the
// most-played/most-wins/most-losses/best-and-worst-win-rate opponents
// (min. 3 matches played for the win-rate picks, to avoid a 1-0 record
// reading as a "100% win rate" callout).
function buildHeadToHead(matches) {
  const byOpponent = new Map();
  for (const m of matches) {
    if (!byOpponent.has(m.opponentId)) byOpponent.set(m.opponentId, { opponentId: m.opponentId, opponentName: m.opponentName, wins: 0, losses: 0 });
    const o = byOpponent.get(m.opponentId);
    o.opponentName = m.opponentName; // keep the most-recently-seen spelling
    if (m.won) o.wins++; else o.losses++;
  }
  const opponents = [...byOpponent.values()].map((o) => ({ ...o, total: o.wins + o.losses, winPct: o.wins / (o.wins + o.losses) }));
  const eligible = opponents.filter((o) => o.total >= 3);

  const maxBy = (arr, key) => arr.reduce((best, o) => (!best || o[key] > best[key] ? o : best), null);
  const minBy = (arr, key) => arr.reduce((best, o) => (!best || o[key] < best[key] ? o : best), null);

  // Most-played opponent (min. 3 matches), with a secondary nudge toward an
  // even 50/50 record — the "well-matched" opponent, as opposed to
  // bestWinRate/worstWinRate which single out the lopsided ends. Sample size
  // is the dominant factor (a 20-match 60/40 rivalry beats a 3-match 50/50
  // one); closeness to 50/50 only breaks near-ties in games played, via a
  // score that multiplies total games by a 0.7-1.0 factor based on closeness.
  const rivalScore = (o) => {
    const closeness = 1 - Math.abs(o.winPct - 0.5) * 2; // 1 = even 50/50, 0 = all-wins/all-losses
    return o.total * (0.7 + 0.3 * closeness);
  };
  const rival = [...eligible].sort((a, b) => rivalScore(b) - rivalScore(a))[0] || null;

  // Longest win/loss streaks: matches aren't stored in strict global
  // chronological order (they're appended tournament-by-tournament, and
  // allTournaments is date-sorted, but same-day/same-tournament matches only
  // have their source platform's "order" as a tiebreaker) — re-sort here
  // rather than assume the incoming order is already chronological.
  const chronological = [...matches].sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.order - b.order));
  let curWin = 0;
  let curLoss = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  for (const m of chronological) {
    if (m.won) { curWin++; curLoss = 0; } else { curLoss++; curWin = 0; }
    if (curWin > longestWinStreak) longestWinStreak = curWin;
    if (curLoss > longestLossStreak) longestLossStreak = curLoss;
  }

  // Giant-killer wins / upset-victim losses: compares each side's own
  // pre-tournament rating (ownRatingAtMatch/opponentRatingAtMatch), not
  // either player's current rating, so a win that was a genuine upset at
  // the time still counts even if the ratings have since converged.
  // DQs are excluded — a walkover isn't a real result.
  let giantKiller = 0;
  let giantKillerMajor = 0;
  let upsetVictim = 0;
  let upsetVictimMajor = 0;
  for (const m of matches) {
    if (m.isDQ || m.ownRatingAtMatch == null || m.opponentRatingAtMatch == null) continue;
    const gap = m.opponentRatingAtMatch - m.ownRatingAtMatch; // positive = opponent was rated higher
    if (m.won) {
      if (gap >= GIANT_KILLER_GAP) giantKiller++;
      if (gap >= GIANT_KILLER_GAP_MAJOR) giantKillerMajor++;
    } else {
      if (-gap >= GIANT_KILLER_GAP) upsetVictim++;
      if (-gap >= GIANT_KILLER_GAP_MAJOR) upsetVictimMajor++;
    }
  }

  return {
    mostPlayed: maxBy(opponents, 'total'),
    mostWinsAgainst: maxBy(opponents.filter((o) => o.wins > 0), 'wins'),
    mostLossesAgainst: maxBy(opponents.filter((o) => o.losses > 0), 'losses'),
    bestWinRate: maxBy(eligible, 'winPct'),
    worstWinRate: minBy(eligible, 'winPct'),
    rival,
    longestWinStreak,
    longestLossStreak,
    giantKiller,
    giantKillerMajor,
    upsetVictim,
    upsetVictimMajor,
  };
}

// --- Output builders ---

function buildPlayerRows(players, tournamentMetaByUrl, lastActiveById) {
  return [...players.entries()]
    .map(([id, p]) => {
      const name = displayName(p);
      const info = lookupPlayerInfo(id, name);
      return {
        id,
        name,
        wins: p.wins,
        losses: p.losses,
        games: p.games,
        winPct: p.games > 0 ? p.wins / p.games : 0,
        lastActive: formatMonthYearHuman(lastActiveById.get(id)),
        location: info.city
          ? [info.city, info.state].filter(Boolean).join(', ')
          : info.state
          ? (STATE_NAMES[info.state] || info.state)
          : (info.country || ''),
        flag: flagForInfo(info),
        locationSort: [info.state, info.city].filter(Boolean).join('|').toLowerCase(),
        state: info.state || '',
        tournaments: [...p.tournaments.entries()].map(([url, label]) => ({
          url,
          label,
          location: (tournamentMetaByUrl.get(url) || {}).location || '',
          slug: (tournamentMetaByUrl.get(url) || {}).slug || '',
        })),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// Identity/location fields for a player that don't vary with the point in
// time being displayed (unlike rating/wins/losses/games) -- split out of
// buildRankingRow so the Rankings tab's "View rankings at" history payload
// (see rankingHistory in main()) can ship this once per player instead of
// once per player per checkpoint, which would otherwise dominate its size.
function buildPlayerMeta(id, p, lastActiveById) {
  const name = displayName(p);
  const info = lookupPlayerInfo(id, name);
  return {
    name,
    location: info.city
      ? [info.city, info.state].filter(Boolean).join(', ')
      : info.state
      ? (STATE_NAMES[info.state] || info.state)
      : (info.country || ''),
    flag: flagForInfo(info),
    locAbbr: abbrevForInfo(info),
    locationSort: [info.state, info.city].filter(Boolean).join('|').toLowerCase(),
    state: info.state || '',
    color: info.color || '',
    lastActive: lastActiveById ? formatMonthYearHuman(lastActiveById.get(id)) : '',
  };
}

// Shared by buildRankingRows (current standings) and buildRankingRowsAt
// (a historical checkpoint) — everything about a ranking row except which
// wins/losses/games/rating snapshot it's built from.
function buildRankingRow(id, p, wins, losses, games, g, lastActiveById) {
  return {
    id,
    ...buildPlayerMeta(id, p, lastActiveById),
    r: g.r,
    rd: g.rd,
    conservativeRating: glicko2.conservativeRating(g),
    wins,
    losses,
    games,
    winPct: games > 0 ? wins / games : 0,
    uncertain: Math.round(g.rd) > GLICKO_UNCERTAIN_RD_THRESHOLD,
  };
}

// placementChange is positions gained/lost in the overall standings since
// the previous tournament (grouped — see groupIdFor) — e.g. +3 means the
// player climbed 3 spots, not that their rating rose. rows must already be
// in final rank order (conservativeRating descending) when this runs, since
// rank is read off as each row's index. previousRanks reflects the field as
// it stood right before the most recent group, so a player missing from it
// hadn't played yet (isNew) rather than having a real 0.
//
// participantIds, if passed, restricts the badge to players who actually
// played *this* group's tournament(s) -- everyone else is left with no
// isNew/placementChange at all (no badge), even though their numeric rank
// may have shifted. Without this, a couple of new entrants slotting into
// the top of the field pushes the entire unchanged rest of the field down
// one spot each, painting most of the board red for players who didn't even
// compete.
function applyPlacementChange(rows, previousRanks, participantIds) {
  if (!previousRanks) return;
  rows.forEach((r, i) => {
    if (participantIds && !participantIds.has(r.id)) return;
    const rank = i + 1;
    const prevRank = previousRanks.get(r.id);
    r.isNew = prevRank == null;
    r.placementChange = prevRank == null ? null : prevRank - rank;
  });
}

function buildRankingRows(players, glicko, previousRanks, participantIds, lastActiveById) {
  const rows = [...players.entries()]
    .map(([id, p]) => {
      const g = glicko.get(id) || { r: GLICKO_DEFAULT_R, rd: GLICKO_DEFAULT_RD, sigma: GLICKO_DEFAULT_SIGMA };
      return buildRankingRow(id, p, p.wins, p.losses, p.games, g, lastActiveById);
    })
    .filter((r) => r.games > 0)
    .sort((a, b) => b.conservativeRating - a.conservativeRating);
  applyPlacementChange(rows, previousRanks, participantIds);
  return rows;
}

// Reconstructs ranking rows as they stood at a past point in history, from
// a processChronologically snapshot's ratings/stats maps (see groupCheckpoints
// in main()) instead of the live players/glicko maps. Player identity (name,
// location, color) still comes from the live `players` map — those don't
// meaningfully change over time and aren't snapshotted per-tournament.
function buildRankingRowsAt(players, ratings, stats, previousRanks, participantIds, lastActiveById) {
  const rows = [...stats.entries()]
    .map(([id, s]) => {
      const p = players.get(id);
      if (!p) return null;
      const g = ratings.get(id) || { r: GLICKO_DEFAULT_R, rd: GLICKO_DEFAULT_RD, sigma: GLICKO_DEFAULT_SIGMA };
      return buildRankingRow(id, p, s.wins, s.losses, s.games, g, lastActiveById);
    })
    .filter((r) => r && r.games > 0)
    .sort((a, b) => b.conservativeRating - a.conservativeRating);
  applyPlacementChange(rows, previousRanks, participantIds);
  return rows;
}

// --- Writers ---

// Small line-art glyphs (16x16, single stroke, no fill) that distinguish the
// Match Statistics grid's tiles at a glance — otherwise every tile is just a
// muted all-caps label over a value, and with 14 of them the section reads
// as a wall of same-looking boxes. Two pairs share one path via CSS mirroring
// (icon-flip) instead of hand-drawing an inverse shape: trend up/down, and
// the giant-killer/upset-victim "breakout" arrow.
const H2H_ICONS = {
  // Lucide/Feather's "trending-up" glyph (rescaled from its native 24x24 to
  // this set's 16x16) — flipping it via icon-flip (scaleY(-1) about the
  // viewBox's own vertical center) lands exactly on "trending-down", since
  // the two are themselves vertical mirrors of each other around that axis.
  trendUp: '<polyline points="15.3,4 9,10.3 5.7,7 0.7,12"/><polyline points="11.3,4 15.3,4 15.3,8"/>',
  swords: '<circle cx="8" cy="8" r="6"/><path d="M5.3 8.2l1.8 1.8 3.6-4"/>', // "swords" name is stale — used for Most Wins Against, now a check-circle glyph
  shield: '<circle cx="8" cy="8" r="6"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>', // "shield" name is stale — used for Most Losses Against, now an x-circle glyph
  loop: '<circle cx="8" cy="8.7" r="5.3"/><path d="M8 5.7v3l2.4 1.4"/><path d="M4.2 2.3L2.7 3.8"/>', // "loop" name is stale — used for Most Played, now a history-clock glyph
  vs: '<path d="M8 2v11"/><path d="M3 5h10"/><path d="M3 5l-1.7 4.2a2 2 0 0 0 3.9 0L3 5z"/><path d="M13 5l-1.7 4.2a2 2 0 0 0 3.9 0L13 5z"/><path d="M6 13h4"/>', // "vs" name is stale — used for Rival, now a balance-scale glyph
  star: '<path d="M8 2l1.8 3.8 4.2.4-3.2 2.9.9 4.1L8 11.2 4.3 13.2l.9-4.1L2 6.2l4.2-.4L8 2z"/>',
  mountain: '<path d="M2 13L6 5l2.5 4L11 5l3 8H2z"/>',
  flame: '<path d="M8 14c-3 0-4.5-2-4.5-4.2C3.5 7 5 5.5 5.5 3c1 1.5 1 3 2 3 .5-2 2-3 2-4.5 2 2 3.5 4 3.5 6.5C13 12 11 14 8 14z"/>',
  snowflake: '<path d="M8 2v12M3 5l10 6M13 5L3 11"/>',
  podium: '<rect x="2" y="9" width="3" height="5"/><rect x="6.5" y="5" width="3" height="9"/><rect x="11" y="7" width="3" height="7"/>',
  // "brackets" name is stale — used for Top 8 Rate, now an ascending
  // step-ladder glyph (four rising bars, like ranked tiers).
  brackets: '<path d="M2 13h2v-2.5H2zM5 13h2V8H5zM8 13h2V5H8zM11 13h2V2h-2z"/>',
  // Giant Killer / Upset Victim: a shield (always upright) with an arrow
  // inside pointing up or down — kept as two separate full glyphs rather
  // than one path shared via icon-flip, since flipping the shield itself
  // upside down would look wrong; only the arrow direction should change.
  breakout: '<path d="M8 2l5 2v4c0 4-2.5 6-5 7-2.5-1-5-3-5-7V4l5-2z"/><path d="M8 10V5M6 7l2-2 2 2"/>',
  breakoutDown: '<path d="M8 2l5 2v4c0 4-2.5 6-5 7-2.5-1-5-3-5-7V4l5-2z"/><path d="M8 5V10M6 8l2 2 2-2"/>',
};

function h2hIcon(key, flip) {
  const inner = H2H_ICONS[key];
  if (!inner) return '';
  return `<svg class="h2h-icon${flip ? ' icon-flip' : ''}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// 'up' / 'down' / 'new' / null (no prior snapshot to compare against, or a
// genuinely flat 0 change) — shared by rankDeltaHtml (the corner badge) and
// the rank number itself (writeHtml colors .rank-plain to match via a
// rank-plain-<state> class), so both always agree on which of the three
// states a player is in.
function rankDeltaState(p) {
  if (p.isNew) return 'new';
  if (!p.placementChange) return null;
  return p.placementChange > 0 ? 'up' : 'down';
}

// Small corner badge riding off the rank number showing how many places
// (not rating points) the player moved since the previous tournament
// (grouped — see groupIdFor) — e.g. a player who stayed #1 while gaining
// rating shows no badge at all, since their placement didn't change.
function rankDeltaHtml(p) {
  const state = rankDeltaState(p);
  if (state === 'new') return `<span class="rank-delta rank-delta-new">NEW</span>`;
  if (state === 'up') return `<span class="rank-delta rank-delta-up">&#9650;${p.placementChange}</span>`;
  if (state === 'down') return `<span class="rank-delta rank-delta-down">&#9660;${Math.abs(p.placementChange)}</span>`;
  return '';
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// prefix is '' from a root-level page (index.html) or '../' from one level
// deep (tournaments/*.html, players/*.html) — same convention as playerHref.
function siteFooter(prefix) {
  const year = new Date().getFullYear();
  // Grouped into two rows -- credits+Ko-Fi, then sources+correction -- so
  // each link sits directly after the thing it's most related to instead of
  // all four being one undifferentiated wrapping line.
  return `<footer class="site-footer">
  <span class="footer-row">
    <span class="footer-copyright"><span class="footer-copyright-full">&copy; ${year} LilyLambda – Power Rankings Site | Tony Hauber – DeathBall</span><span class="footer-copyright-short">&copy; ${year} LilyLambda, Tony Hauber</span></span>
    <a href="https://ko-fi.com/lilylambda" target="_blank" rel="noopener">Support on Ko-Fi</a>
  </span>
  <span class="footer-row">
    <span>Data sourced from <a href="https://start.gg" target="_blank" rel="noopener">start.gg</a> &amp; <a href="https://challonge.com" target="_blank" rel="noopener">Challonge</a></span>
    <a href="https://forms.gle/sKJ9eT7RGgf4aAr17" target="_blank" rel="noopener">Submit a correction</a>
  </span>
</footer>`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Formats a stored YYYY-MM-DD date as "Month D, YYYY" for display (the raw
// ISO form stays in use everywhere else — sorting, slugs, lastActiveDate
// comparisons — since it's lexicographically sortable and unambiguous).
// Built from the string's own digits rather than `new Date(iso)` +
// toLocaleDateString, which parses a bare date as UTC midnight and can
// print the previous day once shifted to a negative-UTC-offset local time
// zone (every US zone).
function formatDateHuman(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  const [, y, mo, d] = m;
  return `${MONTH_NAMES[parseInt(mo, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

// "Month YYYY" ("July 2025") — used for the Historical Rating chart's start/
// end axis labels, where the exact day isn't meaningful but the month still
// is (unlike formatMonthYearHuman below, which drops the month entirely).
function formatMonthYearHumanFull(iso) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso || '');
  if (!m) return iso || '';
  const [, y, mo] = m;
  return `${MONTH_NAMES[parseInt(mo, 10) - 1]} ${y}`;
}

const MONTH_ABBR = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];

// "Mon. D 'YY" ("Jul. 10 '26") — condensed form of formatDateHuman for the
// Matches/Tournaments list rows on player pages, which get too tight for a
// full "July 10, 2026" once the whole row has to fit a phone-width column.
function formatDateShort(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  const [, y, mo, d] = m;
  return `${MONTH_ABBR[parseInt(mo, 10) - 1]} ${parseInt(d, 10)} '${y.slice(2)}`;
}

// Renders both the full and condensed date forms side by side, one hidden
// via CSS depending on viewport (see .date-full/.date-short in writeCss) —
// avoids needing JS to reformat dates client-side just for a mobile layout.
function dateDualHtml(iso) {
  return `<span class="date-full">${escapeHtml(formatDateHuman(iso))}</span><span class="date-short">${escapeHtml(formatDateShort(iso))}</span>`;
}

// Year only ("2025") — used for "Last Active" on the Map tab, where the
// exact month/day isn't meaningful.
function formatMonthYearHuman(iso) {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(iso || '');
  return m ? m[1] : (iso || '');
}

// "Month, Year" ("July, 2025") — used for the Rankings tab's "View rankings
// at" dropdown, which needs to stay short enough to fit its option text on
// one line.
function formatMonthCommaYear(iso) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso || '');
  if (!m) return iso || '';
  const [, y, mo] = m;
  return `${MONTH_NAMES[parseInt(mo, 10) - 1]}, ${y}`;
}

// Today as a YYYY-MM-DD string, built from local date parts (not
// toISOString(), which is UTC and can read as tomorrow/yesterday depending
// on the machine's timezone) -- used to filter upcoming-events.json down to
// events that haven't passed yet.
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Parses upcoming-events.json's optional "H, S%, L%" color triple (e.g.
// "205, 80%, 55%") into the three raw pieces an event card's inline style
// feeds to CSS custom properties -- kept as strings (not numbers) since the
// saturation/lightness parts carry their own "%" and get used verbatim
// inside hsl()/hsla() in the generated CSS.
function parseHsl(raw) {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 3 || !parts.every(Boolean)) return null;
  return { h: parts[0], s: parts[1], l: parts[2] };
}

function writeCsv(rows) {
  const header = ['Player', 'Wins', 'Losses', 'Games Played', 'Win %', 'Location', 'Tournament Count', 'Tournaments'];
  const csvRows = rows.map((p) => [
    p.name, p.wins, p.losses, p.games, (p.winPct * 100).toFixed(1),
    p.location,
    p.tournaments.length,
    p.tournaments.map((t) => t.label).join('; '),
  ]);
  const csv = [header, ...csvRows]
    .map((row) => row.map((v) => (typeof v === 'string' && (v.includes(',') || v.includes(';')) ? `"${v.replace(/"/g, '""')}"` : v)).join(','))
    .join('\n');
  fs.writeFileSync(path.join(__dirname, 'players.csv'), csv);
}

function writeCss() {
  const css = `@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Rajdhani:wght@400;500;600;700&family=Orbitron:wght@400;700;900&display=swap');

* { box-sizing: border-box; }
[hidden] { display: none !important; }
/* display:flex + min-height:100vh so .site-footer's margin-top:auto (below)
   can push it to the bottom of the viewport on short pages instead of
   riding up under sparse content -- on tall pages it just sits after the
   last child like normal block flow, since there's no leftover space to
   push into. */
body { font-family: 'Rajdhani', system-ui, sans-serif; margin: 0; padding: 1.5rem 2rem; background: #050505; color: #f0f0f0; font-size: 1rem; display: flex; flex-direction: column; min-height: 100vh; }
h1 { font-family: 'Press Start 2P', monospace; font-size: 1.6rem; letter-spacing: 0.05em; margin: 0 0 1.5rem; color: #fff; }
#tab-heading { display: inline-block; transition: opacity 180ms ease, transform 180ms ease; }
#tab-heading.h1-swap { opacity: 0; transform: translateY(-6px); }
a { color: #3eff8b; text-decoration: none; }
a:hover { text-decoration: underline; }
.tabs { display: flex; gap: 0; margin-bottom: 1.5rem; border-bottom: 1px solid #222; position: relative; }
.tab-button { background: none; border: none; border-bottom: 2px solid transparent; color: #555; font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; padding: 0.6rem 1.2rem; cursor: pointer; margin-bottom: -1px; transition: color 150ms ease; }
.tab-button:hover { color: #bbb; }
.tab-button.active { color: #3eff8b; }
/* Positioned/sized by JS (enableTabs) to sit under whichever tab is active,
   sliding there via the left/width transition instead of the underline
   just appearing under the newly-clicked tab and disappearing from the old
   one. */
.tab-underline { position: absolute; bottom: -1px; height: 2px; background: #3eff8b; transition: left 220ms ease, width 220ms ease; }
.tab-panel { display: none; }
.tab-panel.active { display: block; }
.tab-controls { display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
.tab-controls label { color: #888; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; display: flex; align-items: center; gap: 0.5rem; }
/* appearance:none drops the native arrow entirely, so a chevron is drawn as
   a background image instead (color-scheme:dark keeps the native option
   popup itself dark too, since that part can't be styled directly). */
.tab-controls select { background: #111 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 0.65rem center; background-size: 0.6rem; color: #f0f0f0; border: 1px solid #333; border-radius: 3px; padding: 0.32rem 1.8rem 0.32rem 0.7rem; font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 600; transition: border-color 150ms, background-color 150ms; appearance: none; -webkit-appearance: none; cursor: pointer; color-scheme: dark; }
.tab-controls select:hover { border-color: #555; background-color: #161616; }
.tab-controls select:focus { outline: none; border-color: #3eff8b; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%233eff8b' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
/* Option text ("July, 2025 - Combo Breaker 2026") can run long -- clip the
   closed control itself so the whole toolbar row stays on one line; the
   open dropdown's own option list is unaffected and still shows full text. */
.pr-history-select { max-width: 12rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.filter-count, .ranking-count { color: #555; font-size: 0.9rem; font-weight: 500; }
#count { color: #555; font-size: 0.9rem; margin-bottom: 1rem; }
.view-toggle { display: flex; gap: 0; background: #111; border: 1px solid #333; border-radius: 3px; padding: 2px; flex-shrink: 0; position: relative; }
/* Same sliding-indicator treatment as .tab-underline above, but as a filled
   pill behind the buttons rather than a line under them (positioned/sized
   by JS in enableViewToggle). */
.view-toggle-indicator { position: absolute; top: 2px; bottom: 2px; background: #3eff8b; border-radius: 2px; transition: left 200ms ease, width 200ms ease; }
.view-btn, .delta-btn { position: relative; z-index: 1; background: none; border: none; color: #555; font-family: 'Rajdhani', sans-serif; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 0.3rem 0.85rem; border-radius: 2px; cursor: pointer; transition: color 150ms; }
.view-btn.active, .delta-btn.active { color: #000; }
.view-btn:not(.active):hover, .delta-btn:not(.active):hover { color: #bbb; }
/* Grid-only toggle -- the up/down/new badge never renders in the table
   view at all (see rankingTableRows), so this pill is hidden whenever the
   Grid/Table switch is on Table (see the [hidden] boolean attribute set in
   enableViewToggle). Desktop collapses it entirely; the mobile override
   below (inside the max-width query) turns this back into
   visibility:hidden instead, so on a phone it still reserves its own box
   rather than shifting the Min Games/Max RD controls sitting next to it. */
.rank-delta-toggle[hidden] { display: none; }
/* Two separate elements share the .download-btn hook/behavior classes
   (see writeJs, which wires both up identically) but only one is ever
   visible at a given viewport width: .download-btn-boxed is the original
   labeled button living inside the Power Rankings tab-controls row
   (desktop); .download-btn-icon is a plain icon-only control in
   .page-title-row, top-right, next to .tabs-toggle (mobile) -- it needs to
   stay reachable regardless of whether the mobile Options panel is
   collapsed, which the boxed version inside that panel can't guarantee. */
.download-btn[hidden] { display: none; }
.download-btn:disabled { cursor: default; opacity: 0.85; }
/* Spinner swaps in for .download-icon while generating -- see the
   downloadBtn click handler in initPanel/enableViewToggle, which toggles
   .loading and disables the button for the duration so a second click
   can't kick off a concurrent export mid-generation. Path is a ~300 degree
   open ring (not a full circle) so the rotation itself reads as motion. */
.download-spinner { display: none; flex-shrink: 0; animation: download-spin 0.7s linear infinite; }
.download-btn.loading .download-icon { display: none; }
.download-btn.loading .download-spinner { display: block; }
@keyframes download-spin { to { transform: rotate(360deg); } }
.download-btn-boxed { display: inline-flex; align-items: center; gap: 0.4rem; margin-left: auto; background: #111; border: 1px solid #333; border-radius: 3px; color: #aaa; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.85rem; letter-spacing: 0.06em; text-transform: uppercase; padding: 0.35rem 0.9rem; cursor: pointer; transition: border-color 150ms, color 150ms; }
.download-btn-boxed:hover { border-color: #3eff8b; color: #3eff8b; }
.download-btn-boxed.failed { border-color: #ff5c5c; color: #ff5c5c; }
.download-btn-boxed .download-icon, .download-btn-boxed .download-spinner { width: 14px; height: 14px; flex-shrink: 0; }
.download-btn-icon { display: none; align-items: center; justify-content: center; flex-shrink: 0; background: none; border: none; padding: 0; margin: 0; color: #aaa; cursor: pointer; transition: color 150ms; }
.download-btn-icon:hover { color: #3eff8b; }
.download-btn-icon.failed { color: #ff5c5c; }
.download-btn-icon .download-icon, .download-btn-icon .download-spinner { width: 20px; height: 20px; flex-shrink: 0; }
.map-legend { display: flex; align-items: center; gap: 0.5rem; color: #888; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.map-legend-swatch { display: inline-block; width: 90px; height: 10px; border-radius: 2px; background: linear-gradient(to right, hsl(150, 70%, 16%), hsl(150, 70%, 60%)); border: 1px solid #333; }
/* Fixed 2:1 column split (not flex-grow based) so the map's box never
   resizes when the sidebar's content changes — the sidebar is always
   present (full unfiltered list by default, filtered to a region on
   click), never toggling in/out of layout the way it briefly did before.
   No max-width: map + list together fill the same full content width as
   every other tab's table. */
.map-panel { display: grid; grid-template-columns: 2fr 1fr; gap: 1.5rem; }
.map-canvas { min-width: 0; }
/* Fixed pixel height (not width-relative "auto") so the map never changes
   size — only its width, via the 4fr column, flexes with viewport width. */
.map-svg { width: 100%; height: 600px; display: block; }
.map-region { fill: rgba(255, 255, 255, 0.05); stroke: #050505; stroke-width: 0.75; transition: fill 200ms ease, stroke 150ms ease; cursor: pointer; }
.map-region:hover { stroke: #3eff8b; stroke-width: 1.5; }
.map-region.selected { stroke: #3eff8b; stroke-width: 2; }
.map-label { font-family: 'Rajdhani', sans-serif; font-size: 11px; font-weight: 700; fill: #eee; text-anchor: middle; dominant-baseline: middle; pointer-events: none; paint-order: stroke; stroke: #000; stroke-width: 2px; stroke-linejoin: round; }
/* Deliberately no card box (background/border) — matches the plain,
   unboxed section + list look used on player pages (see .tourney-section),
   not a bordered "widget" look. */
.map-sidebar { min-width: 0; height: 600px; display: flex; flex-direction: column; }
.map-sidebar-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; border-bottom: 1px solid #222; padding-bottom: 0.4rem; margin-bottom: 0.75rem; flex-shrink: 0; }
.map-sidebar-back { background: none; border: none; color: #3eff8b; font-family: 'Rajdhani', sans-serif; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 0; cursor: pointer; flex-shrink: 0; }
.map-sidebar-back:hover { text-decoration: underline; }
.map-sidebar-title { margin: 0; font-family: 'Rajdhani', sans-serif; font-size: 1rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #3eff8b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.map-sidebar-empty { color: #555; font-size: 0.88rem; padding: 0.4rem 0; }
.map-sidebar-list { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
/* Name truncation is normally keyed off nth-child(2) (see .standings-list li
   > span:nth-child(2) above), which assumes every row starts with a
   standings-rank span — the map sidebar's tournament rows don't have one,
   so truncation is pinned to the class directly instead of row position. */
.hist-tourney-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Bigger than the player-page default (this list is the sidebar's main
   content, not a secondary history section) — scoped to the map sidebar
   only so player pages' own lists are untouched. */
.map-sidebar-list .hist-tourney-name { font-size: 1.05rem; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 1rem; }
#rankings-tab table { user-select: none; }
th, td { padding: 0.55rem 0.75rem; border-bottom: 1px solid #1a1a1a; text-align: left; vertical-align: middle; }
/* z-index needed now that .rank-delta badges (absolutely positioned,
   protruding above their row) exist in tbody -- without it, a sticky th
   (DOM-order stacking, no z-index of its own) paints *behind* a scrolled-up
   row's overflowing content instead of covering it. */
th { cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 1; background: #111; color: #666; font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; border-bottom: 1px solid #222; }
th:hover { background: #181818; color: #f0f0f0; }
th.no-sort { cursor: default; }
th.no-sort:hover { background: #111; color: #666; }
th.sorted-asc::after { content: " \\25B2"; }
th.sorted-desc::after { content: " \\25BC"; }
tbody tr { transition: background 150ms; }
tbody tr:hover td { background: rgba(62,255,139,0.04); }
tbody tr:hover td:first-child { box-shadow: inset 2px 0 0 #3eff8b; }
.rank-num { position: relative; font-family: 'Orbitron', monospace; color: #666; text-align: right; min-width: 2rem; font-size: 0.85rem; font-weight: 900; }
/* Rating-change corner badge: grid-cards only (see rankDeltaHtml's call
   sites — the table row never even emits this markup). Shown by default
   (see the "show" button's initial "active" class + #rankings-tab's
   initial show-rank-delta class in writeHtml()); the rank-delta-toggle pill
   can still switch it off. left: max(1em, 50%) + translateX(-50%) centers
   the badge directly above the rank number's own box for wide (multi-digit)
   ranks, same as plain left:50% would -- but for a narrow single-digit rank
   whose own box is well under 2em wide, 50% alone would let the badge
   drift left almost to the card's edge, so the max() floors the anchor at
   1em from .prc-rank's own left edge (~= the card's left edge, since
   .prc-rank sits right at the card's padded content start) instead of
   letting it keep shrinking with the digit. Both sides are resolved against
   the positioned ancestor's own box, so this stays correct no matter how
   wide the rank digits render in whatever font is active at paint time
   (fallback vs. Orbitron), with no JS remeasurement needed. Deliberately
   overflowing (absolute, off the top) rather than reserving space, so it
   never changes a card's size. background is kept at 0 opacity rather than
   removed outright -- easy to dial back up if bare colored text over a
   card's own background turns out to be hard to read. All three variants
   (up/down/new) sit at the same top offset -- a down badge floating below
   the number instead just read as detached from it, so direction is
   conveyed by the arrow glyph/color alone, not position. rank-plain holds
   just the numeral so JS renumbering (filtering/sorting) can overwrite it
   without clobbering the badge above it — see the .prc-rank query
   selectors in writeJs(). Zero rating change (or no prior snapshot to
   compare against) renders nothing at all. */
.rank-delta { display: none; position: absolute; left: max(1em, 50%); top: calc(-0.8em - 4px); transform: translateX(-50%); background: rgba(0,0,0,0); border-radius: 2px; padding: 0 3px; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.66em; line-height: 1.5; white-space: nowrap; }
/* .show-rank-delta is not scoped to #rankings-tab specifically -- the same
   class is stamped directly onto downloadRankingsImage's offscreen export
   clone (a plain child of <body>, not a descendant of #rankings-tab) when
   the live toggle is on, so an exported PR image matches whatever the
   on-page toggle was showing at click time. */
.show-rank-delta .rank-delta { display: block; }
.rank-delta-up { color: #3eff8b; }
.rank-delta-down { color: #ff5c5c; }
.rank-delta-new { color: #b04fff; }
/* The rank number itself picks up the same up/down/new color as its badge
   (rank-plain-<state>, set alongside rankDeltaHtml's call in writeHtml() --
   both read rankDeltaState so they can never disagree), but only while the
   toggle actually has badges showing; otherwise the number would silently
   keep broadcasting direction even after the delta's been hidden. */
.show-rank-delta .rank-plain-up { color: #3eff8b; }
.show-rank-delta .rank-plain-down { color: #ff5c5c; }
.show-rank-delta .rank-plain-new { color: #b04fff; }
.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.col-location { white-space: nowrap; }
.loc-flag { height: 1em; vertical-align: middle; margin-right: 0.35em; border-radius: 1px; }
.loc-venue { color: #f0f0f0; font-weight: 700; }
.loc-citystate { color: #888; }
.loc-sep { color: #444; margin: 0 0.4em; }
.tourney-loc { display: flex; align-items: center; }
.uncertain { opacity: 0.45; }
.filter-dim { opacity: 0.45; }
.pr-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 5px; }
.pr-card { background: #0f0f0f; border: 1px solid #222; border-radius: 0; padding: 3px 6px; display: flex; flex-direction: column; gap: 2px; min-width: 0; transition: border-color 150ms, background 150ms; user-select: none; }
.pr-card.card-green { background: radial-gradient(ellipse at 20% 0%, rgba(62,255,139,0.22) 0%, #0f0f0f 65%); }
.pr-card.card-purple { background: radial-gradient(ellipse at 20% 0%, rgba(176,79,255,0.22) 0%, #0f0f0f 65%); }
.pr-card.card-green:hover { background: radial-gradient(ellipse at 20% 0%, rgba(62,255,139,0.38) 0%, #181818 65%); border-color: rgba(62,255,139,0.65); }
.pr-card.card-purple:hover { background: radial-gradient(ellipse at 20% 0%, rgba(176,79,255,0.38) 0%, #181818 65%); border-color: rgba(176,79,255,0.6); }
.pr-card.uncertain { opacity: 1; }
.pr-card.filter-dim { opacity: 1; }
.pr-card.filter-dim.card-green, .pr-card.filter-dim.card-purple,
.pr-card.uncertain.card-green, .pr-card.uncertain.card-purple { background: #000; }
.pr-card.filter-dim.card-green:hover, .pr-card.filter-dim.card-purple:hover,
.pr-card.uncertain.card-green:hover, .pr-card.uncertain.card-purple:hover { background: #0a0a0a; border-color: #333; }
/* .prc-rank sits directly in this flex row (not wrapped with the name in a
   sub-container) specifically so .rank-delta, which pokes up/down past
   .prc-rank's own box, isn't clipped by an ancestor's overflow:hidden --
   .prc-name carries its own overflow/min-width for ellipsis truncation, so
   the old wrapper wasn't needed for that either. */
.prc-top { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-width: 0; }
.prc-rank { position: relative; font-family: 'Orbitron', monospace; font-size: 1.2rem; color: #888; font-weight: 900; flex-shrink: 0; line-height: 1; }
/* flex: 1 1 0 (not the default 0 1 auto) so this box's width comes purely
   from available flex-row space, not from its own text's content width —
   otherwise shrinking the font also shrinks the box being measured against,
   and fitText() in index.js can converge on a false "it fits" reading before
   the text actually does. */
.prc-name { flex: 1 1 0; font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; line-height: 18px; font-weight: 700; color: #f0f0f0; overflow: hidden; text-overflow: clip; white-space: nowrap; min-width: 0; position: relative; top: 1px; }
/* width is fixed (not auto) so this box's footprint is known before the
   (external, async-loaded) flag image itself has actually loaded — otherwise
   the row lays out too wide the first time fitCardNames() runs (on load,
   pre-image-load), then reflows narrower once the image arrives with no
   further re-fit, leaving names under-shrunk until something else (e.g. the
   grid/table view toggle) happens to re-trigger fitCardNames(). */
.prc-flag { height: 1.15em; width: 1.5em; object-fit: contain; border-radius: 2px; flex-shrink: 0; box-shadow: 0 1px 3px rgba(0,0,0,0.6); }
.prc-stats { display: flex; align-items: baseline; gap: 2px; }
.prc-loc-abbr { font-family: 'Rajdhani', sans-serif; font-size: 0.78rem; font-weight: 700; color: #777; letter-spacing: 0.04em; margin-left: auto; padding-left: 4px; flex-shrink: 0; }
.prc-val { font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 700; color: #aaa; }
.prc-dim { font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 600; color: #444; }
.prc-sep { font-size: 0.75rem; color: #333; font-family: 'Rajdhani', sans-serif; font-weight: 600; margin: 0 1px; }
/* Positioned so its four corners land one row up from where cards 43-46
   (top edge) and 91-94 (bottom edge) would fall in the 8-column grid (row =
   floor(index/8)+1, col = index%8+1) — this only lines up at the 8-column
   breakpoint, so it's hidden below that rather than recomputed per
   breakpoint. The download export clone forces 8 columns and re-shows it
   inline regardless of viewport (see downloadRankingsImage). */
/* Height is pinned to exactly 7 native card rows (7 * 45.6px card height +
   6 * 5px grid row-gap = 349.2px, measured live) rather than left to grow
   with content -- letting it grow taller stretches the grid's row tracks,
   which also stretches every other card sharing those rows. box-sizing:
   border-box so padding/border count inside that height; overflow:hidden
   is a clip guard, not the primary fit mechanism -- inner content is sized
   to actually fit, verified against the real 7-row height via screenshots
   rather than computed on paper (font metrics don't add up cleanly by hand). */
/* position:relative so .pr-square-mascot (an absolutely positioned direct
   child) sits relative to the square itself -- without this, since no
   other ancestor is positioned on the live page (and the export clone's
   ancestor is position:fixed), the mascot falls back to the initial
   containing block and renders miles away from the square. */
/* Hidden on the live site -- it only ever shows up in the downloaded image
   (downloadRankingsImage clones it and explicitly overrides this back to
   flex for the export). */
.pr-square { display: none; position: relative; grid-column: 3 / 7; grid-row: 5 / 12; height: 349.2px; box-sizing: border-box; background: #0a0a0a; border: 1px solid #3eff8b; padding: 10px 14px; flex-direction: column; gap: 1em; user-select: none; box-shadow: 0 0 24px rgba(62,255,139,0.15); overflow: hidden; }
.pr-square-title { display: flex; align-items: center; justify-content: center; gap: 8px; font-family: 'Orbitron', monospace; font-weight: 900; font-size: 1.6rem; color: #fff; letter-spacing: 0.05em; text-align: center; white-space: nowrap; flex: none; }
.pr-square-logo { height: 1.6em; width: auto; }
.pr-square-row { display: flex; gap: 16px; flex: 1; min-height: 0; }
/* Breathing room above the second row so it doesn't butt against the first. */
.pr-square-row-2 { margin-top: 2em; position: relative; }
/* Percentage-based (not fixed px) so it stays roughly between the stats and
   the tagline whether measured on the live responsive grid or the download
   export's fixed-width clone, which render the square at different pixel
   widths. Sits in the empty gap between the two flex columns via absolute
   positioning so it doesn't participate in / disturb their flex sizing. */
.pr-square-mascot { position: absolute; bottom: 0; left: 50%; width: 15%; object-fit: contain; pointer-events: none; }
.pr-square-col { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
/* "How to read a card" only needs to fit the demo card + callouts, so it
   shrinks to content; "how rankings are determined" gets the extra space. */
.pr-square-col-card { flex: 0 0 auto; }
.pr-square-col-text { flex: 1 1 0; }
/* Right-aligned and non-growing so the tagline sits close to the QR code
   next to it instead of centered in its own wide flex share. */
.pr-square-col-tagline { flex: 0 1 auto; align-items: flex-end; }
.pr-square-label { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.68rem; letter-spacing: 0.07em; text-transform: uppercase; color: #666; }
.pr-square-text { font-family: 'Rajdhani', sans-serif; font-size: 0.74rem; color: #999; line-height: 1.3; }
.pr-square-example { pointer-events: none; width: 210px; flex: none; }
.pr-square-callouts { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.pr-square-callout { font-family: 'Rajdhani', sans-serif; font-size: 0.66rem; color: #666; }
.pr-square-callout b { color: #aaa; }
.pr-square-qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; flex-shrink: 0; }
.pr-square-qr { width: 78px; height: 78px; display: flex; align-items: center; justify-content: center; }
.pr-square-qr img { width: 100%; height: 100%; object-fit: contain; }
.pr-square-qr-label { font-family: 'Rajdhani', sans-serif; font-size: 0.6rem; color: #666; letter-spacing: 0.04em; text-transform: uppercase; }
/* Grid (not flex) so three stat tiles are guaranteed to fit within the
   column's own width instead of overflowing into the next column when
   their combined natural width exceeds it. */
.pr-square-stats { display: grid; grid-template-columns: 4em 4em 4em; gap: 3em; }
.pr-square-stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pr-square-stat-num { font-family: 'Orbitron', monospace; font-weight: 900; font-size: 1.05rem; color: #3eff8b; line-height: 1; }
.pr-square-stat-label { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.55rem; letter-spacing: 0.02em; text-transform: uppercase; color: #666; }
/* Outer gap separates independent label+item(s) groups (e.g. "Next
   Tournament" vs "Latest Tournament"); each group's own inner gap (below)
   stays tight since a label sits directly above its own item(s). */
.pr-square-latest { margin-top: 4px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pr-square-latest-group { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.pr-square-latest-item { font-family: 'Rajdhani', sans-serif; font-size: 0.66rem; color: #999; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr-square-tagline { font-family: 'Orbitron', monospace; font-weight: 900; font-size: 0.95rem; color: #fff; line-height: 1.35; text-align: right; overflow-wrap: break-word; }
.pr-square-footer { font-family: 'Rajdhani', sans-serif; font-size: 0.62rem; color: #555; text-align: left; flex: none; }
/* Off-screen clone target used by downloadRankingsImage — not display:none
   (html2canvas needs real layout) so it's shoved out via position instead. */
.pr-export-grid { position: fixed; top: 0; left: -10000px; z-index: -1; }
@media (max-width: 1100px) { .pr-grid { grid-template-columns: repeat(4, 1fr); } .pr-square { display: none; } }
@media (max-width: 600px) { .pr-grid { grid-template-columns: repeat(2, 1fr); } body { padding: 1rem; } }
.events-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
@media (max-width: 1100px) { .events-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 700px) { .events-grid { grid-template-columns: 1fr; } }
/* --eh/--es/--el default to the site's amber (hsl(36,100%,65%) ~= #ffb74d)
   via each var()'s fallback argument; an event's "color" field in
   upcoming-events.json overrides them via an inline style on .event-card
   (see parseHsl/buildEventsTabHtml) instead of needing a separate CSS class
   per hue. */
.event-card { display: flex; flex-direction: column; gap: 6px; background: radial-gradient(ellipse at 20% 0%, hsla(var(--eh, 36), var(--es, 100%), var(--el, 65%), 0.16) 0%, #0f0f0f 70%); border: 1px solid hsla(var(--eh, 36), var(--es, 100%), var(--el, 65%), 0.4); border-radius: 0; padding: 1.1rem 1.3rem; text-decoration: none; box-shadow: 0 0 18px hsla(var(--eh, 36), var(--es, 100%), var(--el, 65%), 0.08); transition: border-color 150ms, background 150ms, box-shadow 150ms, transform 150ms; }
.event-card:hover { border-color: hsl(var(--eh, 36), var(--es, 100%), var(--el, 65%)); background: radial-gradient(ellipse at 20% 0%, hsla(var(--eh, 36), var(--es, 100%), var(--el, 65%), 0.3) 0%, #181818 70%); box-shadow: 0 0 28px hsla(var(--eh, 36), var(--es, 100%), var(--el, 65%), 0.2); text-decoration: none; transform: translateY(-2px); }
/* Only cards with a logo (has-image) split into columns -- imageless cards
   stay a plain single-column block so there's no empty 2/5 gap. */
.event-card.has-image { flex-direction: row; align-items: center; gap: 14px; }
.event-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 3 1 0; }
.event-image-wrap { flex: 2 1 0; display: flex; align-items: center; justify-content: center; min-width: 0; height: 100%; }
.event-image { max-width: 100%; max-height: 100px; object-fit: contain; }
.event-date { font-family: 'Orbitron', monospace; font-weight: 900; font-size: 0.95rem; letter-spacing: 0.04em; color: hsl(var(--eh, 36), var(--es, 100%), var(--el, 65%)); text-transform: uppercase; }
.event-name { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 1.3rem; color: #fff; line-height: 1.2; }
.event-venue { display: flex; align-items: center; gap: 6px; font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; color: #999; }
.events-footer { font-family: 'Rajdhani', sans-serif; font-size: 0.85rem; color: #666; text-align: center; margin-top: 1.5rem; letter-spacing: 0.03em; }
.events-empty { font-family: 'Rajdhani', sans-serif; font-size: 1.1rem; color: #888; text-align: center; padding: 3rem 0; }
.doubles-pill { display: inline-block; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; color: #b04fff; border: 1px solid rgba(176,79,255,0.5); border-radius: 3px; padding: 1px 7px; margin-left: 6px; vertical-align: middle; }
/* Player-page "w/ <partner>" pill -- the partner's name is a real link, so
   it keeps its own casing (uppercase would obscure/mangle it) and stays
   unstyled-as-a-link until hover, matching the pill's own color scheme
   instead of the browser-default blue/underline. */
.doubles-pill.doubles-pill-plain { text-transform: none; letter-spacing: 0.01em; }
.doubles-pill.doubles-pill-plain a { color: inherit; text-decoration: none; }
.doubles-pill.doubles-pill-plain a:hover { text-decoration: underline; }
/* align-items: start keeps each card sized to its own content -- without
   it, CSS Grid's default row-stretch makes every card in a row match the
   tallest one, which matters here since a player-page doubles card's height
   varies with how many tournaments it lists (see .doubles-card .standings-list
   below), unlike the Doubles tab's uniform two-line cards. */
/* auto-fit (not a fixed repeat(3, 1fr)) so the column count always derives
   from the actual container's width, not the viewport's -- this covers both
   the full-width Doubles tab and h2h's own narrow 1-of-3 column on mixed
   player pages, where a lone card (or a trailing odd one) stretches to
   fill its row instead of sitting in a narrow track beside empty ones,
   since auto-fit collapses tracks with no content rather than reserving
   space for them the way a fixed column count would. The min() wrapped
   around the minmax minimum keeps a single column from overflowing a
   container narrower than 380px (e.g. a phone screen) -- minmax's own
   minimum can't shrink below itself, only its maximum can, so without
   min() a narrow-enough container would force a horizontal scrollbar
   instead of the card just shrinking to fit. */
.doubles-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(380px, 100%), 1fr)); gap: 20px; align-items: start; }
/* Doubles-only players' 2-of-3-column-wide area (.doubles-only-grid) wants
   the opposite of auto-fit's collapsing behavior: a lone card should stay
   at 1-column width with visible empty space beside it (matching a normal
   card's size elsewhere on the site), not stretch to fill both columns --
   so this overrides the base rule with a genuinely fixed 2-track grid
   instead. */
.doubles-only-grid .doubles-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 700px) { .doubles-only-grid .doubles-grid { grid-template-columns: 1fr; } }
.doubles-card { display: flex; flex-direction: column; gap: 8px; background: #0f0f0f; border: 1px solid #222; border-radius: 0; padding: 1.1rem 1.3rem; transition: border-color 150ms, background 150ms; }
.doubles-card.card-green { background: radial-gradient(ellipse at 20% 0%, rgba(62,255,139,0.22) 0%, #0f0f0f 65%); }
.doubles-card.card-purple { background: radial-gradient(ellipse at 20% 0%, rgba(176,79,255,0.22) 0%, #0f0f0f 65%); }
.doubles-card.card-green:hover { background: radial-gradient(ellipse at 20% 0%, rgba(62,255,139,0.38) 0%, #181818 65%); border-color: rgba(62,255,139,0.65); }
.doubles-card.card-purple:hover { background: radial-gradient(ellipse at 20% 0%, rgba(176,79,255,0.38) 0%, #181818 65%); border-color: rgba(176,79,255,0.6); }
.doubles-card-names { font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 1.2rem; color: #fff; line-height: 1.3; }
.doubles-card-names a { color: #fff; }
.doubles-card-names a:hover { color: #3eff8b; }
.doubles-amp { color: #666; font-weight: 400; }
.doubles-card-stats { font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; color: #999; display: flex; align-items: center; gap: 8px; }
.doubles-sep { color: #444; }
.doubles-empty { font-family: 'Rajdhani', sans-serif; font-size: 1.1rem; color: #888; text-align: center; padding: 3rem 0; }
/* Player page Doubles section reuses .doubles-grid itself (not just
   .doubles-card), so multiple partner cards can lay out side by side
   within h2h's own column (see .player-grid.has-doubles) exactly like the
   Doubles tab, rather than always stacking one per row. Each card also
   carries its own per-tournament list, so it needs a bit more internal
   spacing than the tab's plain stat line. */
.doubles-card .standings-list { margin-top: 0.5rem; }
.back-link { display: inline-block; color: #888; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 1rem; }
.back-link:hover { color: #3eff8b; }
.tourney-meta { display: flex; align-items: center; gap: 1.25rem; color: #888; font-size: 1.05rem; margin: -1rem 0 0.5rem; }
.tourney-meta a { margin: 0; }
.ext-link { font-size: 0.8rem; margin-left: 0.4rem; opacity: 0.7; }
.tourney-section { margin-bottom: 2rem; }
.tourney-section h2 { font-family: 'Rajdhani', sans-serif; font-size: 1rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #3eff8b; border-bottom: 1px solid #222; padding-bottom: 0.4rem; margin-bottom: 0.75rem; }
/* Rating-over-time chart (player pages). Fixed pixel height with a
   viewBox-scaled SVG, same "never resize the plot itself" approach as the
   map's .map-svg — only the wrap's width flexes with the page. */
/* Chart gets the same "mostly opaque" translucent card look as the
   stat-tile/h2h-tile cards elsewhere on the page — see those for the same
   background/border/blur values. */
.rating-chart-wrap { width: 100%; background: rgba(10,10,10,0.35); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); border-radius: 3px; padding: 1.5rem 1.5rem 0.75rem; box-sizing: border-box; }
/* The svg and its label/tooltip overlays are positioned as siblings inside
   this unpadded inner box, not directly inside .rating-chart-wrap — every
   label's top/left is a percentage of the SVG's own H/W, and percentage
   offsets on an absolutely-positioned element resolve against its
   containing block's padding box, so that only lines up if this box has no
   padding of its own. .rating-chart-wrap's padding is what actually keeps
   the chart from butting up against the card edges. */
.rating-chart-inner { position: relative; width: 100%; height: 220px; }
.rating-chart { width: 100%; height: 100%; display: block; overflow: visible; }
.chart-grid { stroke: #1a1a1a; stroke-width: 1; }
.chart-line { fill: none; stroke: #3eff8b; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.chart-dot { fill: #3eff8b; stroke: #050505; stroke-width: 1.5; pointer-events: none; transition: r 120ms ease; }
.chart-hit { fill: transparent; cursor: pointer; }
/* Axis/date/current-value labels are HTML overlays (not SVG <text>), pinned
   to the inner box's edges via CSS percentages — the SVG itself uses
   preserveAspectRatio="none" so the plot fills the column's full width
   without side letterboxing, and non-uniform x/y scaling of embedded SVG
   text would visibly stretch it. Sizing these as HTML instead keeps the
   labels crisp and lets them be sized larger independent of that scaling. */
.chart-label { position: absolute; font-family: 'Rajdhani', sans-serif; font-size: 0.85rem; font-weight: 600; color: #888; pointer-events: none; white-space: nowrap; }
.chart-label-y { left: 0; transform: translateY(-50%); }
.chart-label-date-start { left: 0; bottom: -0.6rem; }
.chart-label-date-end { right: 0; bottom: -0.6rem; }
/* Anchored via "right" (not "left") so the label grows leftward off the
   last point instead of rightward past the edge of the chart. Nudged up an
   extra few px past the plain -100% flip so it doesn't sit flush against
   the point/line it's labeling. */
.chart-label-current { font-family: 'Orbitron', monospace; font-size: 1rem; font-weight: 700; color: #3eff8b; transform: translateY(calc(-100% - 5px)); }
.chart-point:focus { outline: none; }
.chart-point:focus .chart-dot, .chart-point:hover .chart-dot { r: 5.5; }
/* Positioned in JS against the inner box's own rect (not the viewport), so
   it tracks correctly regardless of how the SVG's preserveAspectRatio scales
   the underlying viewBox coordinates to the box's actual rendered size. */
.chart-tooltip { position: absolute; transform: translate(-50%, -100%) translateY(-10px); background: #111; border: 1px solid #333; border-radius: 3px; padding: 0.4rem 0.6rem; font-size: 0.8rem; line-height: 1.4; color: #ddd; white-space: nowrap; pointer-events: none; z-index: 2; }
.chart-tooltip strong { color: #3eff8b; }
/* Standings and the bracket/round list side by side — a narrow standings
   list otherwise leaves most of the page empty next to it. The bracket
   column has no fixed width (min-width:0 lets it shrink below its content's
   natural size); brackets-viewer already scrolls itself horizontally (see
   its own overflow:auto), so a wide bracket scrolls in place instead of
   forcing the columns apart. flex-wrap alone (no media query needed) drops
   the bracket to its own full-width row below standings once the viewport
   is too narrow for both to fit at a reasonable size. */
.tourney-columns { display: flex; align-items: flex-start; gap: 2.5rem; flex-wrap: wrap; }
.tourney-standings { flex: 0 0 240px; }
.tourney-matches { flex: 1 1 520px; min-width: 0; }
.round-group { margin-bottom: 1.25rem; }
.round-group h3 { font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #666; margin: 0 0 0.4rem; }
.match-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0; border-bottom: 1px solid #161616; font-size: 0.95rem; }
.match-winner { font-weight: 700; color: #f0f0f0; }
.match-loser { color: #888; }
.match-score { font-variant-numeric: tabular-nums; color: #3eff8b; font-weight: 700; margin-left: auto; }
.match-dq { color: #ff5e5e; font-size: 0.8rem; }
.standings-list { list-style: none; margin: 0; padding: 0; counter-reset: none; }
.standings-list li { display: flex; align-items: baseline; gap: 0.75rem; padding: 0.4rem 0.75rem; border-bottom: 1px solid #161616; cursor: pointer; transition: background-color 150ms ease; }
.standings-rank { font-family: 'Orbitron', monospace; color: #666; font-weight: 900; min-width: 2rem; flex-shrink: 0; }
.standings-list li > span:nth-child(2) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.standings-record { color: #777; font-variant-numeric: tabular-nums; margin-left: auto; flex-shrink: 0; white-space: nowrap; }
/* Synced with the bracket: hovering or clicking a player in either place
   highlights them in both (see setupBracketInteractivity in the bracket
   head script). */
.standings-list li.player-active { background-color: rgba(62,255,139,0.12); }
.stage-label { font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #3eff8b; margin: 1.5rem 0 0.75rem; }
.stage-label:first-child { margin-top: 0; }
.bracket-incomplete-note { color: #ffb74d; font-size: 0.9rem; background: rgba(255,183,77,0.08); border: 1px solid rgba(255,183,77,0.3); border-radius: 3px; padding: 0.5rem 0.75rem; margin: 0 0 0.75rem; }
.crosstable-wrap { overflow-x: auto; }
.crosstable { border-collapse: collapse; font-size: 0.85rem; }
.crosstable th, .crosstable td { border: 1px solid #1a1a1a; padding: 0.4rem 0.6rem; text-align: center; white-space: nowrap; }
.crosstable th { background: #111; color: #888; font-weight: 700; font-size: 0.78rem; letter-spacing: 0.04em; }
.crosstable th.row-name { text-align: left; color: #f0f0f0; }
.crosstable td.cell-diag { background: #0a0a0a; }
.crosstable td.cell-empty { color: #333; }
.crosstable td.cell-win { color: #3eff8b; font-weight: 700; }
.crosstable td.cell-loss { color: #ff5e5e; }
.crosstable td.cell-draw { color: #ccc; }
h1 img.loc-flag { height: 0.75em; margin-right: 0.4em; }
.alias-list { color: #888; font-size: 0.9rem; }
/* 13-column grid so Record (3) + Goals (4) + the combined ranking card (6)
   line up evenly across one row on wide screens. */
.player-stats-grid { display: grid; grid-template-columns: repeat(13, 1fr); gap: 0.75rem; }
.stat-span-3 { grid-column: span 3; }
.stat-span-4 { grid-column: span 4; }
.stat-span-6 { grid-column: span 6; }
@media (max-width: 700px) {
  .player-stats-grid { grid-template-columns: repeat(2, 1fr); }
  .stat-span-3, .stat-span-4, .stat-span-6 { grid-column: span 2; }
}
.stat-tile { position: relative; background: rgba(10,10,10,0.35); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); border-radius: 3px; padding: 1rem 0.9rem; min-height: 5.5rem; display: flex; flex-direction: column; gap: 0.15rem; justify-content: center; }
.stat-value { font-family: 'Rajdhani', sans-serif; font-size: 1.4rem; font-weight: 700; color: #f0f0f0; }
.stat-label { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #666; }
.stat-sub { font-size: 1rem; font-weight: 700; color: #3eff8b; }
.stat-multi { display: flex; gap: 1.25rem; flex-wrap: wrap; row-gap: 0.4rem; }
.stat-multi > span { display: flex; flex-direction: column; gap: 0.15rem; }
/* Positioned out of flow so a qualification note doesn't add a line to the
   stat-multi row it sits under — the tile's height (and every other item's
   vertical centering within it) stays identical whether or not the note is
   present, instead of the row growing/shifting when it appears. */
.stat-note { position: absolute; left: 0.9rem; right: 0.9rem; bottom: 0.6rem; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em; color: #3eff8b; }
.rank-total { font-family: 'Rajdhani', sans-serif; font-size: 0.7rem; font-weight: 600; color: #666; }
/* Fixed width so "1st"/"21st" etc. don't shift the record that follows it. */
.rank-ordinal { display: inline-block; width: 2.8em; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 1.05rem; color: #f0f0f0; }
.player-columns { display: flex; gap: 2.5rem; flex-wrap: wrap; }
.player-col { flex: 1 1 300px; min-width: 0; }
/* Used instead of .player-columns when a rating chart is present: the chart
   takes the width of two columns (same as Matches+Tournaments together)
   with Match Statistics beside it, then Matches/Tournaments fill the row below
   — Match Statistics spans both rows so it "extends into" that lower row
   whenever its own content runs taller than the chart. */
.player-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-template-areas: "chart chart h2h" "matches tournaments h2h"; gap: 2.5rem; }
.chart-col { grid-area: chart; min-width: 0; }
.h2h-col { grid-area: h2h; min-width: 0; }
.matches-col { grid-area: matches; min-width: 0; }
.tournaments-col { grid-area: tournaments; min-width: 0; }
/* For a mixed player, the Doubles section is nested directly inside
   .h2h-col (right after Match Statistics) rather than being a grid item of
   its own, so it picks up its spacing from a margin here instead of
   .player-grid's inter-item gap the way a sibling grid cell would --
   .doubles-col's own grid-area only actually applies in .doubles-only-grid
   below. The "Doubles Teams" <h2>'s UA-default top margin (0.83em) would
   otherwise collapse through the empty .doubles-col box and add on top of
   this, so it's zeroed and this margin is the only spacing above the
   section. Scoped to the nested (.h2h-col) case specifically -- in
   .doubles-only-grid, .doubles-col is a grid-area sibling of
   .tournaments-col and needs its top to stay flush with the grid row (no
   margin) so the two columns' headers line up. */
.doubles-col { grid-area: doubles; min-width: 0; }
.doubles-col h2 { margin-top: 0; }
.h2h-col .doubles-col { margin-top: 1.25rem; }
/* Doubles-only players (no singles play at all) skip the chart/stats/match
   log entirely -- Tournaments takes the left 1 of 3 columns, Doubles the
   right 2, same 3-column grid as everyone else's page. */
.player-grid.doubles-only-grid { grid-template-areas: "tournaments doubles doubles"; }
@media (max-width: 900px) {
  .player-grid { grid-template-columns: 1fr; grid-template-areas: "chart" "h2h" "matches" "tournaments"; }
  .player-grid.doubles-only-grid { grid-template-areas: "tournaments" "doubles"; }
}
.h2h-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem; }
.h2h-tile { background: rgba(10,10,10,0.35); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.08); border-radius: 3px; padding: 0.6rem 0.9rem; display: flex; flex-direction: column; gap: 0.15rem; }
.h2h-label { display: flex; align-items: center; gap: 0.35rem; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #666; }
.h2h-value { font-family: 'Rajdhani', sans-serif; font-size: 1.15rem; font-weight: 700; }
/* Line-art glyphs distinguishing each Match Statistics tile at a glance — see
   H2H_ICONS in aggregate_players.js. stroke: currentColor picks up the
   label's own muted color for free; icon-flip mirrors one path for its
   opposite-meaning pair (trend up/down, giant-killer/upset-victim) instead
   of hand-drawing an inverse shape. */
.h2h-icon { width: 14px; height: 14px; flex-shrink: 0; }
.icon-flip { transform: scaleY(-1); }
.h2h-count { font-family: 'Orbitron', monospace; font-size: 1.05rem; font-weight: 900; color: #f0f0f0; }
.h2h-record-dim { font-family: 'Rajdhani', sans-serif; font-size: 0.85rem; font-weight: 600; color: #666; }
.standings-rank { white-space: nowrap; }
/* Fixed width so a longer score (e.g. "12-11") doesn't wrap onto its own
   line or butt up against the W/L letter before it. Margin is asymmetric —
   more space separating it from the W/L letter, much less before the
   opponent name that follows (the li's flex gap already provides some). */
.match-score-mini { display: inline-block; width: 1.2em; font-family: 'Rajdhani', sans-serif; font-size: 0.8rem; font-weight: 600; color: #888; }
.match-tourney-name { font-size: 0.85em; color: #999; }
.match-tourney-name a { color: #999; }
.match-tourney-name a:hover { color: #3eff8b; }
.standings-rank.result-win { color: #3eff8b; }
.standings-rank.result-loss { color: #ff5e5e; }
/* Fixed width so "W" and "L" — different glyph widths in this font — don't
   shift the score/opponent columns that follow depending on which one shows. */
.result-letter { display: inline-block; width: 1.6em; text-align: center; }
.hist-record { display: inline-block; width: 1.8em; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.95rem; color: #3eff8b; }
.hist-tourney-name { font-size: 0.85em; }
.hist-tourney-name a { color: #777; }
.hist-tourney-name a:hover { color: #3eff8b; }
.show-more-btn { display: inline-block; margin-top: 0.6rem; background: none; border: none; padding: 0; color: #3eff8b; font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; font-weight: 700; cursor: pointer; }
/* Map sidebar: multi-column layout (name + placement/rating/last-active for
   players, name + date for tournaments) with a matching header row above
   the list — overrides standings-list's flex row (declared earlier) with a
   grid so every column lines up with its header regardless of content
   length. Column count/labels are set by JS (renderMapSidebar) via the
   map-cols-players/map-cols-tournaments classes on both this header and
   the list itself, so their grid-template-columns stay in sync. */
.map-sidebar-colhead { display: grid; gap: 0.5rem; padding: 0 0.75rem 0.35rem; font-family: 'Rajdhani', sans-serif; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #555; }
.map-sidebar-colhead span:not(:first-child) { text-align: right; }
.map-sidebar-colhead span { cursor: pointer; user-select: none; }
.map-sidebar-colhead span:hover { color: #999; }
.map-sidebar-colhead span.sorted-asc, .map-sidebar-colhead span.sorted-desc { color: #3eff8b; }
.map-sidebar-colhead span.sorted-asc::after { content: " \\25B2"; }
.map-sidebar-colhead span.sorted-desc::after { content: " \\25BC"; }
.map-sidebar-list li { display: grid; gap: 0.5rem; }
.map-sidebar-list li > span:not(:first-child) { text-align: right; margin-left: 0; }
/* The map-cols-* class is toggled onto both the header div (which is
   itself the grid, so this rule applies directly) and the <ol> (which
   isn't a grid — its <li> children are), hence the two selector forms. */
.map-sidebar-colhead.map-cols-players, ol.map-cols-players li { grid-template-columns: 1fr 3.4rem 6.5rem 4rem; }
.map-sidebar-colhead.map-cols-tournaments, ol.map-cols-tournaments li { grid-template-columns: 1fr 8.5rem; }
/* Player pages carry a background glow matching their power-ranking card
   color (see cardAccent) — card-green vs card-purple varies the glow for
   visual variety, but page text always stays the site's green accent
   regardless of which glow is showing. */
body.card-green, body.card-purple { min-height: 100vh; }
body.card-green { background: radial-gradient(ellipse at 20% 0%, rgba(0, 70, 30) 0%, #050505 55%); }
body.card-purple { background: radial-gradient(ellipse at 20% 0%, rgba(40, 0, 70) 0%, #050505 55%); }
.show-more-btn:hover { text-decoration: underline; }
.site-footer { margin-top: auto; padding-top: 1rem; border-top: 1px solid #222; display: flex; flex-wrap: wrap; gap: 0.4rem 1.2rem; align-items: center; color: #555; font-size: 0.8rem; }
.site-footer a { color: #777; }
.site-footer a:hover { color: #3eff8b; }
/* --- Mobile responsiveness (max-width queries + a couple of touch-only
   rules that are inert without a touchscreen, so nothing here can ever
   affect a mouse/desktop-width viewport) --- */
/* h1 loses its own bottom margin here since .page-title-row (which wraps it
   together with the hamburger icon and the download icon) carries that
   margin instead -- see writeHtml, where index.html's h1 is the only one
   wrapped this way (player/tournament page h1s are untouched, plain
   elements, so their own margin: 0 0 1.5rem rule still applies to them). */
.page-title-row { display: flex; align-items: baseline; gap: 0.75rem; margin-bottom: 1.5rem; }
.page-title-row h1 { margin: 0; flex: 1 1 auto; min-width: 0; }
.tabs-toggle { display: none; }
/* Off by default (no .options-open class) above the mobile breakpoint too,
   but the toggle button itself is display:none there, so .tab-controls'
   normal (always visible) CSS is the only thing that ever applies on desktop. */
.rankings-options-toggle { display: none; }
/* Hidden on desktop -- the "Historical Rating"-style heading above the top
   stat grid only exists to label that grid once it's the first thing on the
   page on mobile (see .player-title-row and h1 shrinking below); on desktop
   the grid sits directly under the page title where a label is redundant. */
.mobile-only-heading { display: none; }
.player-title-row { display: block; }
.aka-toggle { display: none; }
.aka-content { display: none; }
.footer-copyright-short { display: none; }
/* .footer-row is display:contents on desktop so each pairing (credits+Ko-Fi,
   sources+correction) still renders as independent flex items of
   .site-footer, wrapping wherever the row happens to break -- the grouping
   only turns into an actual visual row once .site-footer switches to
   flex-direction:column on mobile (see below). */
.footer-row { display: contents; }
.date-short { display: none; }
.stat-label-short { display: none; }
/* Lets a two-finger touch gesture on the map be handled entirely by
   enableMapPinchZoom (see writeJs) instead of the browser's own page-zoom/
   scroll gesture recognizer grabbing it first. No effect for mouse/desktop
   input, so this isn't gated behind a max-width query. */
.map-svg { touch-action: none; }
@media (max-width: 700px) {
  h1 { font-size: 1.1rem; }
  /* Hamburger replaces the full tab row -- six tabs (Power Rankings/Players/
     Tournaments/Doubles/Map/Events) don't fit a phone width even scrolled --
     as a plain white icon next to the page title (no button box), matching
     .download-btn's own icon-only look on the opposite side of the row.
     Clicking it slides .tabs in from the left edge as a fixed drawer over a
     dimming backdrop, rather than a dropdown that would otherwise need to
     find room directly under a title row that's now also holding the
     download icon. */
  .tabs-toggle { display: flex; align-items: center; justify-content: center; background: none; border: none; padding: 0; color: #ccc; cursor: pointer; flex-shrink: 0; }
  .tabs-toggle:hover { color: #3eff8b; }
  .tabs-toggle-icon { width: 20px; height: 20px; }
  .tabs { flex-direction: column; position: fixed; top: 0; bottom: 0; left: 0; width: 78%; max-width: 300px; background: #0a0a0a; border-right: 1px solid #222; z-index: 50; padding: 4rem 1.25rem 1.5rem; margin-bottom: 0; transform: translateX(-100%); transition: transform 220ms ease; }
  .tabs.mobile-open { transform: translateX(0); }
  .tab-button { text-align: left; padding: 0.7rem 1rem; border-bottom: 1px solid #161616; margin-bottom: 0; }
  .tab-underline { display: none; }
  .tabs-backdrop { display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 40; }
  .tabs-backdrop.mobile-open { display: block; }

  /* Swap which download button is visible -- the boxed one (inside the
     Power Rankings tab-controls row) only makes sense on desktop; mobile
     shows the plain icon in .page-title-row instead, top-right next to
     .tabs-toggle. Both share the same [hidden]/loading/failed state (see
     updateDownloadVisibility/enableViewToggle in writeJs), so only their
     display toggles here, not their visibility logic. */
  .download-btn-boxed { display: none; }
  .download-btn-icon { display: inline-flex; }

  /* Fixed 240px standings column (see .tourney-standings above) can pinch
     the bracket column on a narrow phone -- stack them instead, same as
     flex-wrap already does once both no longer fit side by side at a
     reasonable size. */
  .tourney-standings { flex: 1 1 100%; }
  .tourney-matches { flex: 1 1 100%; }
  /* Tournament page: location / date / "view original" each pinned to their
     own line via column layout, reordered (source order stays date/location/
     link, unchanged for desktop) and clipped with an ellipsis instead of
     wrapping a second time within their own line. */
  .tourney-meta { flex-direction: column; align-items: flex-start; gap: 0.3rem; }
  .tourney-meta > * { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tourney-loc { order: 1; }
  .tourney-date { order: 2; }
  .tourney-original-link { order: 3; }

  /* Power Rankings tab: filters/view-toggles/download collapse behind an
     Options button instead of sitting open above the grid by default. */
  .rankings-options-toggle { display: flex; align-items: center; gap: 0.4rem; background: #111; border: 1px solid #333; border-radius: 3px; color: #aaa; font-family: 'Rajdhani', sans-serif; font-weight: 700; font-size: 0.85rem; letter-spacing: 0.08em; text-transform: uppercase; padding: 0.4rem 0.9rem; margin-bottom: 1rem; cursor: pointer; }
  .rankings-options-toggle:hover, .rankings-options-toggle.active { border-color: #3eff8b; color: #3eff8b; }
  .rankings-options-caret { width: 9px; height: 6px; transition: transform 150ms ease; }
  .rankings-options-toggle.active .rankings-options-caret { transform: rotate(180deg); }
  #rankings-options-panel { display: none; }
  /* 2-column grid instead of one long wrapping row of controls -- the
     Grid/Table and Hide/Show-delta pills naturally land in row 1 (one per
     column), then the four filter selects form a clean 2x2 grid below them
     in the same document order they already had. Grid's default
     justify-items:stretch fills each pill's own column width instead of
     leaving it at its cramped intrinsic size -- its two buttons then split
     that width evenly (flex: 1 1 0) rather than sizing to their own text. */
  #rankings-options-panel.options-open { display: grid; grid-template-columns: 1fr 1fr; gap: 0.65rem 0.75rem; align-items: end; }
  #rankings-options-panel.options-open .view-toggle,
  #rankings-options-panel.options-open .rank-delta-toggle { width: 100%; }
  #rankings-options-panel.options-open .view-btn,
  #rankings-options-panel.options-open .delta-btn { flex: 1 1 0; text-align: center; white-space: nowrap; padding-left: 0.4rem; padding-right: 0.4rem; }
  /* Override the desktop [hidden]{display:none} rule above -- on mobile,
     switching to Table view should leave this pill's grid cell empty
     (invisible but still occupying its row) instead of collapsing it and
     shifting Min Games/Max RD up into row 1. Needs !important to beat the
     global [hidden]{display:none !important} rule (see the .pr-card/
     [hidden] note elsewhere in this file), which otherwise wins over any
     non-important rule regardless of selector specificity or source order. */
  .rank-delta-toggle[hidden] { display: flex !important; visibility: hidden; }
  #rankings-options-panel.options-open label { display: flex; flex-direction: column; align-items: flex-start; gap: 0.3rem; }
  #rankings-options-panel.options-open label select { width: 100%; }

  /* Player page: name + AKA toggle share a row; the header matching
     "Historical Rating" only shows here since the grid is the first section
     on the page on mobile. */
  .player-title-row { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; }
  .mobile-only-heading { display: block; }
  .aka-full { display: none; }
  /* Caret sits after the "AKA" text (flex row, not the default marker
     position) and never itself moves -- toggling .open only affects
     .aka-content, a separate full-width block between the name and the
     location/active meta line, so this button's own size/position is
     identical whether the list is open or not. */
  .aka-toggle { display: inline-flex; align-items: center; gap: 0.3rem; background: none; border: none; padding: 0; cursor: pointer; color: #888; font-family: 'Rajdhani', sans-serif; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; user-select: none; }
  .aka-toggle:hover, .aka-toggle.active { color: #3eff8b; }
  .aka-caret { width: 9px; height: 6px; flex-shrink: 0; transition: transform 150ms ease; }
  .aka-toggle.active .aka-caret { transform: rotate(180deg); }
  /* Same -1rem trick .tourney-meta uses below to pull up close under h1's
     own large default margin -- keeps the title-to-AKA gap the same size as
     the title-to-location gap on a page with no AKA line at all. */
  .aka-content { margin: -1rem 0 0; color: #888; font-size: 0.85rem; }
  .aka-content.open { display: block; }
  /* Once AKA is open and visible, .tourney-meta directly follows it instead
     of h1 -- its own -1rem margin-top (tuned for pulling up against h1's
     larger gap) would sit too tight against a line of plain text, so this
     drops it to the same 0.3rem rhythm .tourney-meta already uses between
     its own location/active lines, keeping every line in the block evenly
     spaced. Only matches while .open is present, so a page with the AKA
     toggle closed (or no aliases at all) still gets the normal tourney-meta
     spacing straight off h1. */
  .aka-content.open + .tourney-meta { margin-top: 0.3rem; }

  /* Match Statistics tiles stay 2-per-row instead of collapsing to 1 once
     each tile's 200px minimum no longer fits twice across a phone width. */
  .h2h-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }

  /* Condensed "Jul. 10 '26" dates in the Matches/Tournaments lists (see
     dateDualHtml) instead of the full "July 10, 2026" form. */
  .date-full { display: none; }
  .date-short { display: inline; }

  /* Shorter Match Statistics labels (see dualLabelHtml) -- e.g. "Best Win
     Rate" instead of "Best Win Rate (Min. 3)" -- only on mobile; desktop
     keeps the original, more explicit wording. */
  .stat-label-full { display: none; }
  .stat-label-short { display: inline; }

  /* Footer: condensed copyright, one row per group (credits+Ko-Fi, then
     sources+correction) instead of wrapping wherever the flex row breaks. */
  .site-footer { flex-direction: column; align-items: flex-start; gap: 0.5rem; }
  .footer-copyright-full { display: none; }
  .footer-copyright-short { display: inline; }
  .footer-row { display: flex; gap: 1rem; flex-wrap: wrap; }
}
@media (max-width: 800px) {
  /* 2:1 map/sidebar split (see .map-panel above) is too cramped once the
     map column itself drops under ~300px -- stack map above sidebar and
     shrink the map's own fixed height (still fixed, just a smaller fixed
     value, matching the "never resize dynamically" approach used on desktop). */
  .map-panel { grid-template-columns: 1fr; }
  .map-svg { height: 320px; }
  .map-sidebar { height: 420px; }
  /* Drop the Rating column from the player sidebar list -- Placement and
     Last Active are what people actually scan for on a narrow screen, and
     three number columns plus a name don't have room to breathe. Column
     order is Player/Placement/Rating/Last Active (see MAP_SIDEBAR_COLUMNS
     and renderMapSidebar in writeJs), so Rating is always the 3rd child. */
  .map-sidebar-colhead.map-cols-players, ol.map-cols-players li { grid-template-columns: 1fr 3.4rem 4rem; }
  .map-sidebar-colhead.map-cols-players span:nth-child(3),
  ol.map-cols-players li > span:nth-child(3) { display: none; }
}
`;
  fs.writeFileSync(path.join(REPO_ROOT, 'index.css'), css);
}

function writeJs() {
  const stateNamesJson = JSON.stringify({
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
    KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
    MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
    NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
    OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
    SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
    VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
    DC: 'Washington D.C.',
    AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
    NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories',
    NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec',
    SK: 'Saskatchewan', YT: 'Yukon',
  });

  const js = `(function () {
  const STATE_NAMES = ${stateNamesJson};
  const MAP_REGION_DATA = JSON.parse(document.getElementById('map-region-data')?.textContent || '{}');
  const PR_HISTORY_DATA = JSON.parse(document.getElementById('pr-history-data')?.textContent || '{}');
  const PR_META = PR_HISTORY_DATA.players || {};
  const PR_HISTORY = PR_HISTORY_DATA.checkpoints || [];
  const PR_UNCERTAIN_RD_THRESHOLD = ${GLICKO_UNCERTAIN_RD_THRESHOLD};

  function enableSorting(table) {
    const tbody = table.tBodies[0];
    const headers = [...table.querySelectorAll('th')];
    headers.forEach((th, colIndex) => {
      if (th.classList.contains('no-sort')) return;
      th.addEventListener('click', () => {
        const asc = !th.classList.contains('sorted-asc');
        headers.forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
        th.classList.add(asc ? 'sorted-asc' : 'sorted-desc');

        const rows = [...tbody.rows];
        const type = th.dataset.type;
        rows.sort((a, b) => {
          const cellA = a.cells[colIndex];
          const cellB = b.cells[colIndex];
          if (type === 'number') {
            const valA = Number(cellA.dataset.sort !== undefined ? cellA.dataset.sort : cellA.textContent);
            const valB = Number(cellB.dataset.sort !== undefined ? cellB.dataset.sort : cellB.textContent);
            return asc ? valA - valB : valB - valA;
          }
          const valA = (cellA.dataset.sort !== undefined ? cellA.dataset.sort : cellA.textContent).trim().toLowerCase();
          const valB = (cellB.dataset.sort !== undefined ? cellB.dataset.sort : cellB.textContent).trim().toLowerCase();
          if (th.dataset.blankLast === 'true') {
            const blankA = valA === '';
            const blankB = valB === '';
            if (blankA !== blankB) return blankA ? 1 : -1;
          }
          return asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        });
        rows.forEach((r) => tbody.appendChild(r));
      });
    });
  }

  // Positions indicator (a .tab-underline or .view-toggle-indicator) to
  // sit under/behind target within container, sized to match — called on
  // init and again on every switch so it slides there via the element's
  // own CSS transition instead of just appearing in the new spot.
  function moveIndicator(indicator, container, target) {
    if (!indicator || !container || !target) return;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    indicator.style.left = (targetRect.left - containerRect.left) + 'px';
    indicator.style.width = targetRect.width + 'px';
  }

  const TAB_HEADERS = { 'players-tab': 'Players', 'tournaments-tab': 'Tournaments', 'doubles-tab': 'Doubles Teams', 'rankings-tab': 'Power Rankings', 'map-tab': 'Map', 'events-tab': 'Upcoming Events' };

  // Cross-fades just the variable part of the page heading ("DeathBall" is
  // static) to the tab's own heading instead of snapping straight to it.
  function setHeaderForTab(tabId) {
    const heading = document.getElementById('tab-heading');
    const label = TAB_HEADERS[tabId] || TAB_HEADERS['rankings-tab'];
    if (!heading || heading.textContent === label) return;
    heading.classList.add('h1-swap');
    setTimeout(() => {
      heading.textContent = label;
      heading.classList.remove('h1-swap');
    }, 180);
  }

  function enableTabs() {
    const buttons = [...document.querySelectorAll('.tab-button')];
    const panels = [...document.querySelectorAll('.tab-panel')];
    const tabsEl = document.querySelector('.tabs');
    const underline = document.querySelector('.tab-underline');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        panels.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = document.getElementById(btn.dataset.tab);
        panel.classList.add('active');
        moveIndicator(underline, tabsEl, btn);
        setHeaderForTab(btn.dataset.tab);
        updateDownloadVisibility();
        // Cards were sized while this panel was display:none (offsetWidth 0
        // at page load, or never resized since last becoming visible), so
        // names need a fresh fit now that the panel actually has layout.
        fitCardNames(panel);
        // Same story for any view-toggle pill(s) inside this panel (e.g. the
        // Map tab's Players/Tournaments switch, or the Rankings tab's
        // Grid/Table and rank-delta Hide/Show switches) — indicators were
        // positioned against a zero-width rect while hidden.
        for (const innerToggle of panel.querySelectorAll('.view-toggle')) {
          const innerIndicator = innerToggle.querySelector('.view-toggle-indicator');
          const innerActive = innerToggle.querySelector('.view-btn.active, .delta-btn.active');
          if (innerIndicator && innerActive) moveIndicator(innerIndicator, innerToggle, innerActive);
        }
      });
    });
    moveIndicator(underline, tabsEl, buttons.find((b) => b.classList.contains('active')));
  }

  // Mobile-only hamburger toggle for the tab row (see .tabs-toggle in
  // writeCss) -- .tabs-toggle is display:none above the mobile breakpoint,
  // so this is inert on desktop even though the listener is always attached.
  // .tabs slides in from the left as a fixed drawer over a dimming
  // .tabs-backdrop, which also closes the drawer when tapped.
  function enableTabsMenu() {
    const toggle = document.querySelector('.tabs-toggle');
    const tabsEl = document.querySelector('.tabs');
    const backdrop = document.querySelector('.tabs-backdrop');
    if (!toggle || !tabsEl) return;
    function setOpen(open) {
      tabsEl.classList.toggle('mobile-open', open);
      if (backdrop) backdrop.classList.toggle('mobile-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    }
    toggle.addEventListener('click', () => setOpen(!tabsEl.classList.contains('mobile-open')));
    if (backdrop) backdrop.addEventListener('click', () => setOpen(false));
    // Selecting a tab closes the drawer again rather than leaving it open
    // over the newly-shown panel.
    tabsEl.querySelectorAll('.tab-button').forEach((btn) => {
      btn.addEventListener('click', () => setOpen(false));
    });
  }

  // Mobile-only collapse for the Power Rankings tab's filter/action row (see
  // .rankings-options-toggle in writeCss) -- off by default on mobile so the
  // grid/table of rankings isn't pushed down by a wall of selects before
  // anyone asks for them; the toggle itself is display:none on desktop,
  // where the panel is always visible regardless of this class.
  function enableOptionsToggle() {
    const toggle = document.querySelector('.rankings-options-toggle');
    const panel = document.getElementById('rankings-options-panel');
    if (!toggle || !panel) return;
    toggle.addEventListener('click', () => {
      const open = panel.classList.toggle('options-open');
      toggle.classList.toggle('active', open);
      toggle.setAttribute('aria-expanded', String(open));
      // The Grid/Table and Hide/Show-delta sliding pills were positioned (at
      // page load and on every filter change) while this panel was
      // display:none on mobile -- getBoundingClientRect on a display:none
      // element's children is a zero-size rect, so both pills got stuck at
      // left:0/width:0 until something recomputed them against real layout.
      // Re-run that positioning now that the panel actually has size.
      if (open) {
        for (const innerToggle of panel.querySelectorAll('.view-toggle')) {
          const innerIndicator = innerToggle.querySelector('.view-toggle-indicator');
          const innerActive = innerToggle.querySelector('.view-btn.active, .delta-btn.active');
          if (innerIndicator && innerActive) moveIndicator(innerIndicator, innerToggle, innerActive);
        }
      }
    });
  }

  function populateStateFilter(panel) {
    const select = panel.querySelector('.state-filter-select');
    const tbody = panel.querySelector('table tbody');
    if (!select || !tbody) return;
    const seen = new Set();
    for (const row of tbody.rows) {
      if (row.dataset.state) seen.add(row.dataset.state);
    }
    const sorted = [...seen].sort((a, b) =>
      (STATE_NAMES[a] || a).localeCompare(STATE_NAMES[b] || b)
    );
    for (const abbr of sorted) {
      const opt = document.createElement('option');
      opt.value = abbr;
      opt.dataset.label = STATE_NAMES[abbr] || abbr;
      opt.textContent = opt.dataset.label;
      select.appendChild(opt);
    }
    // Stamp base label on the hardcoded "All locations" option too
    if (select.options[0]) select.options[0].dataset.label = select.options[0].textContent;
  }

  function applyFilters(panel) {
    const minGames = parseInt(panel.querySelector('.min-games-select')?.value || '0', 10);
    const maxRdVal = panel.querySelector('.max-rd-select')?.value || 'Infinity';
    const maxRd = maxRdVal === 'Infinity' ? Infinity : parseFloat(maxRdVal);
    const state = panel.querySelector('.state-filter-select')?.value || '';
    const tbody = panel.querySelector('table tbody');
    const isRankingsTab = panel.id === 'rankings-tab';
    const DEFAULT_MIN_GAMES = 5;
    const DEFAULT_MAX_RD = 150;

    // Use card grid as count source for rankings (avoids double-counting with table).
    // Scoped to direct .pr-card children so the .pr-square promo tile (no
    // data-games/data-rd, not a real ranked player) is never counted, ranked,
    // or hidden by these filters.
    const grid = isRankingsTab ? panel.querySelector('.pr-grid') : null;
    const countSource = grid ? [...grid.querySelectorAll(':scope > .pr-card')] : (tbody ? [...tbody.rows] : []);

    // First pass: count per state for items passing non-state filters
    const stateCounts = new Map();
    let totalPassingNonState = 0;
    for (const el of countSource) {
      const games = parseInt(el.dataset.games || '0', 10);
      const rd = parseFloat(el.dataset.rd || '0');
      if (minGames && games < minGames) continue;
      if (maxRd !== Infinity && rd > maxRd) continue;
      const rowState = el.dataset.state || '';
      stateCounts.set(rowState, (stateCounts.get(rowState) || 0) + 1);
      totalPassingNonState++;
    }

    // Update dropdown option labels with counts
    const stateSelect = panel.querySelector('.state-filter-select');
    if (stateSelect) {
      for (const opt of stateSelect.options) {
        const label = opt.dataset.label || opt.textContent.replace(/\\s*\\(\\d+\\)$/, '');
        const count = opt.value === '' ? totalPassingNonState : (stateCounts.get(opt.value) || 0);
        opt.textContent = label + ' (' + count + ')';
      }
    }

    // Apply filters to table rows
    if (tbody) {
      let rank = 1;
      for (const row of tbody.rows) {
        const games = parseInt(row.dataset.games || '0', 10);
        const rd = parseFloat(row.dataset.rd || '0');
        const rowState = row.dataset.state || '';
        const passesMinMax = (!minGames || games >= minGames) && (maxRd === Infinity || rd <= maxRd);
        const passesState = !state || rowState === state;
        const show = passesMinMax && passesState;
        row.hidden = !show;
        if (isRankingsTab) {
          const meetsDefaults = games >= DEFAULT_MIN_GAMES && rd <= DEFAULT_MAX_RD;
          row.classList.toggle('filter-dim', show && !meetsDefaults);
        } else {
          row.classList.remove('filter-dim');
        }
        if (show) {
          const rankCell = row.querySelector('.rank-num');
          if (rankCell) rankCell.textContent = rank++;
        }
      }
    }

    // Apply filters to card grid (rankings tab only)
    let visible = 0;
    if (grid) {
      let rank = 1;
      for (const card of grid.querySelectorAll(':scope > .pr-card')) {
        const games = parseInt(card.dataset.games || '0', 10);
        const rd = parseFloat(card.dataset.rd || '0');
        const cardState = card.dataset.state || '';
        const passesMinMax = (!minGames || games >= minGames) && (maxRd === Infinity || rd <= maxRd);
        const passesState = !state || cardState === state;
        const show = passesMinMax && passesState;
        card.hidden = !show;
        const meetsDefaults = games >= DEFAULT_MIN_GAMES && rd <= DEFAULT_MAX_RD;
        card.classList.toggle('filter-dim', show && !meetsDefaults);
        if (show) {
          const rankEl = card.querySelector('.prc-rank .rank-plain');
          if (rankEl) rankEl.textContent = rank;
          rank++;
          visible++;
        }
      }
      fitCardNames(panel);
    } else if (tbody) {
      for (const row of tbody.rows) if (!row.hidden) visible++;
    }

    const countEl = panel.querySelector('.filter-count');
    if (countEl) {
      const noun = isRankingsTab ? 'players ranked' : 'unique players';
      // The sort hint only applies while the sortable table is actually the
      // visible view — grid mode has no columns to click.
      const table = panel.querySelector('table');
      const tableVisible = !grid || !table || table.style.display !== 'none';
      countEl.textContent = visible + ' ' + noun + (tableVisible ? '. Click a column header to sort.' : '.');
    }
  }

  function fitText(el, maxPx, minPx) {
    el.style.fontSize = maxPx + 'px';
    let size = maxPx;
    while (el.scrollWidth > el.offsetWidth && size > minPx) {
      size -= 1;
      el.style.fontSize = size + 'px';
    }
  }

  function fitCardNames(panel) {
    const scope = panel || document;
    for (const el of scope.querySelectorAll('.prc-name')) fitText(el, 18, 9);
  }

  // Sequential fill scale from dim (no data) up to bright green, using a
  // sqrt scale so a handful of high-count hubs (e.g. Texas/Minnesota) don't
  // wash out every other state to the same dim shade.
  function countColor(count, max) {
    if (!count) return 'rgba(255, 255, 255, 0.05)';
    const t = max > 0 ? Math.sqrt(count / max) : 0;
    const lightness = 16 + t * 44;
    return 'hsl(150, 70%, ' + lightness.toFixed(1) + '%)';
  }

  function updateMap(panel, view) {
    const regions = [...panel.querySelectorAll('.map-region')];
    const labels = [...panel.querySelectorAll('.map-label')];
    let max = 1;
    for (const r of regions) max = Math.max(max, parseInt(r.dataset[view] || '0', 10));
    regions.forEach((r) => {
      const count = parseInt(r.dataset[view] || '0', 10);
      r.style.fill = countColor(count, max);
    });
    labels.forEach((l) => {
      const count = parseInt(l.dataset[view] || '0', 10);
      l.textContent = count > 0 ? count : '';
    });
  }

  function enableMapToggle(panel) {
    if (!panel) return;
    const buttons = [...panel.querySelectorAll('.view-btn')];
    const toggleEl = panel.querySelector('.view-toggle');
    const indicator = panel.querySelector('.view-toggle-indicator');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        moveIndicator(indicator, toggleEl, btn);
        updateMap(panel, btn.dataset.view);
        // Keep an open region's sidebar in sync with whichever list (players
        // vs tournaments) is now the active view, without touching zoom.
        if (panel._mapRefreshSidebar) panel._mapRefreshSidebar();
      });
    });
    const active = buttons.find((b) => b.classList.contains('active'));
    moveIndicator(indicator, toggleEl, active);
    updateMap(panel, active ? active.dataset.view : 'players');
  }

  function animateViewBox(svg, toBox, duration) {
    const fromBox = svg.getAttribute('viewBox').split(' ').map(Number);
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const box = fromBox.map((v, i) => v + (toBox[i] - v) * eased);
      svg.setAttribute('viewBox', box.join(' '));
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Mirrors the player page's tournament-history-list / recent-matches-list
  // styling (standings-list / standings-rank / hist-tourney-name /
  // standings-record) so this reads as the same kind of list elsewhere on
  // the site, rather than a one-off sidebar design. The sidebar always
  // shows a list — regionId '__ALL__' (the default) shows every
  // player/tournament; clicking a region filters this same list down
  // rather than swapping in a separate view.
  function mapFlagNameSpan(item) {
    const nameSpan = document.createElement('span');
    nameSpan.className = 'hist-tourney-name';
    if (item.f) {
      const img = document.createElement('img');
      img.className = 'loc-flag';
      img.src = item.f.src;
      img.alt = item.f.title;
      img.title = item.f.title;
      nameSpan.appendChild(img);
    }
    if (item.h) {
      const a = document.createElement('a');
      a.href = item.h;
      a.textContent = item.n;
      nameSpan.appendChild(a);
    } else {
      nameSpan.appendChild(document.createTextNode(item.n));
    }
    return nameSpan;
  }

  // Column definitions per view -- key is the field on each item (see
  // toMapPlayerJson/toMapTournamentJson in aggregate_players.js), type
  // picks string vs numeric comparison. Tournament dates sort on the raw
  // ISO field (di), not the pre-formatted display date (d), for the same
  // reason as the main tables: comparing formatted strings would order by
  // month name instead of chronologically.
  const MAP_SIDEBAR_COLUMNS = {
    players: [
      { label: 'Player', key: 'n', type: 'string' },
      { label: 'Placement', key: 'rank', type: 'number' },
      { label: 'Rating', key: 'v', type: 'number' },
      { label: 'Last Active', key: 'la', type: 'string' },
    ],
    tournaments: [
      { label: 'Tournament', key: 'n', type: 'string' },
      { label: 'Date', key: 'di', type: 'string' },
    ],
  };

  function sortMapItems(items, sort, columns) {
    if (!sort) return items;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return items;
    const sorted = items.slice();
    sorted.sort((a, b) => {
      if (col.type === 'number') {
        const valA = Number(a[col.key]);
        const valB = Number(b[col.key]);
        return sort.asc ? valA - valB : valB - valA;
      }
      const valA = String(a[col.key] || '').toLowerCase();
      const valB = String(b[col.key] || '').toLowerCase();
      return sort.asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    });
    return sorted;
  }

  function renderMapSidebar(panel, regionId, view) {
    const data = MAP_REGION_DATA[regionId];
    if (!data) return;
    const list = panel.querySelector('.map-sidebar-list');
    const colhead = panel.querySelector('.map-sidebar-colhead');
    const title = panel.querySelector('.map-sidebar-title');
    const backBtn = panel.querySelector('.map-sidebar-back');
    title.textContent = data.name;
    if (backBtn) backBtn.hidden = regionId === '__ALL__';

    const isTournaments = view === 'tournaments';
    list.classList.toggle('map-cols-players', !isTournaments);
    list.classList.toggle('map-cols-tournaments', isTournaments);
    colhead.classList.toggle('map-cols-players', !isTournaments);
    colhead.classList.toggle('map-cols-tournaments', isTournaments);
    colhead.innerHTML = '';
    if (!panel._mapSort) panel._mapSort = { players: null, tournaments: null };
    const sortKey = isTournaments ? 'tournaments' : 'players';
    const columns = MAP_SIDEBAR_COLUMNS[sortKey];
    const currentSort = panel._mapSort[sortKey];
    columns.forEach((col) => {
      const span = document.createElement('span');
      span.textContent = col.label;
      if (currentSort && currentSort.key === col.key) {
        span.classList.add(currentSort.asc ? 'sorted-asc' : 'sorted-desc');
      }
      span.addEventListener('click', () => {
        // Cycles ascending -> descending -> unsorted (back to the default
        // list order) rather than just flipping asc/desc forever, so there's
        // a way back to the original ordering without a page reload.
        const prev = panel._mapSort[sortKey];
        if (!prev || prev.key !== col.key) {
          panel._mapSort[sortKey] = { key: col.key, asc: true };
        } else if (prev.asc) {
          panel._mapSort[sortKey] = { key: col.key, asc: false };
        } else {
          panel._mapSort[sortKey] = null;
        }
        if (panel._mapRefreshSidebar) panel._mapRefreshSidebar();
        else renderMapSidebar(panel, regionId, view);
      });
      colhead.appendChild(span);
    });

    list.innerHTML = '';
    const items = sortMapItems(isTournaments ? data.tournamentsList : data.playersList, currentSort, columns);
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'map-sidebar-empty';
      li.textContent = 'No ' + view + ' from here yet.';
      list.appendChild(li);
      return;
    }
    items.forEach((item) => {
      const li = document.createElement('li');
      li.appendChild(mapFlagNameSpan(item));
      if (isTournaments) {
        const dateSpan = document.createElement('span');
        dateSpan.className = 'standings-record';
        dateSpan.textContent = item.d || '';
        li.appendChild(dateSpan);
      } else {
        const rankSpan = document.createElement('span');
        rankSpan.className = 'standings-record';
        rankSpan.textContent = '#' + item.rank;
        li.appendChild(rankSpan);
        const ratingSpan = document.createElement('span');
        ratingSpan.className = 'standings-record';
        ratingSpan.textContent = item.v + ' ± ' + item.rd;
        li.appendChild(ratingSpan);
        const lastActiveSpan = document.createElement('span');
        lastActiveSpan.className = 'standings-record';
        lastActiveSpan.textContent = item.la || '';
        li.appendChild(lastActiveSpan);
      }
      list.appendChild(li);
    });
  }

  function zoomToRegion(svg, regionEl) {
    const bbox = regionEl.getBBox();
    const padFactor = 0.4;
    const minSize = 40;
    const w = Math.max(bbox.width * (1 + padFactor * 2), minSize);
    const h = Math.max(bbox.height * (1 + padFactor * 2), minSize);
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    animateViewBox(svg, [cx - w / 2, cy - h / 2, w, h], 450);
  }

  function zoomMapHome(svg) {
    const home = (svg.dataset.home || '').split(' ').map(Number);
    if (home.length === 4 && home.every((n) => !isNaN(n))) animateViewBox(svg, home, 450);
  }

  // Two-finger pinch zoom on the map SVG specifically (touch-only — desktop
  // mouse users are unaffected). touch-action:none on .map-svg (see writeCss)
  // stops the browser from treating this as a page-level gesture first.
  // Zoom is anchored at the pinch midpoint (converted to the SVG's own user
  // space via getScreenCTM, not just the viewBox center) so the point under
  // the fingers stays under the fingers as the box shrinks/grows, clamped to
  // between the full home extent and 15% of it so a pinch can't zoom out
  // past the map's natural bounds or in until it's a meaningless close-up.
  function enableMapPinchZoom(svg) {
    const home = (svg.dataset.home || '').split(' ').map(Number);
    if (home.length !== 4 || home.some((n) => isNaN(n))) return;
    const maxW = home[2];
    const minW = home[2] * 0.15;
    let startDist = null;
    let startBox = null;
    let anchor = null;

    function touchDist(touches) {
      return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    }
    function toSvgPoint(clientX, clientY) {
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      return pt.matrixTransform(ctm.inverse());
    }
    function endPinch() {
      startDist = null;
      startBox = null;
      anchor = null;
    }

    svg.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      startDist = touchDist(e.touches);
      const vb = svg.viewBox.baseVal;
      startBox = { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
      anchor = toSvgPoint(
        (e.touches[0].clientX + e.touches[1].clientX) / 2,
        (e.touches[0].clientY + e.touches[1].clientY) / 2
      );
    }, { passive: false });

    svg.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2 || !startDist || !startBox || !anchor) return;
      e.preventDefault();
      const scale = startDist / touchDist(e.touches);
      const newW = Math.max(minW, Math.min(maxW, startBox.width * scale));
      const newH = newW * (startBox.height / startBox.width);
      const fx = (anchor.x - startBox.x) / startBox.width;
      const fy = (anchor.y - startBox.y) / startBox.height;
      svg.setAttribute('viewBox', (anchor.x - fx * newW).toFixed(2) + ' ' + (anchor.y - fy * newH).toFixed(2) + ' ' + newW.toFixed(2) + ' ' + newH.toFixed(2));
    }, { passive: false });

    svg.addEventListener('touchend', (e) => { if (e.touches.length < 2) endPinch(); });
    svg.addEventListener('touchcancel', endPinch);
  }

  function enableMapRegions(panel) {
    if (!panel) return;
    const svg = panel.querySelector('.map-svg');
    const regions = [...panel.querySelectorAll('.map-region')];
    const backBtn = panel.querySelector('.map-sidebar-back');
    let selectedId = '__ALL__';
    enableMapPinchZoom(svg);

    function currentView() {
      const active = panel.querySelector('.view-btn.active');
      return active ? active.dataset.view : 'players';
    }

    function deselect() {
      regions.forEach((r) => r.classList.remove('selected'));
      selectedId = '__ALL__';
      zoomMapHome(svg);
      renderMapSidebar(panel, selectedId, currentView());
    }

    regions.forEach((r) => {
      r.addEventListener('click', () => {
        if (selectedId === r.dataset.id) { deselect(); return; }
        regions.forEach((other) => other.classList.remove('selected'));
        r.classList.add('selected');
        selectedId = r.dataset.id;
        zoomToRegion(svg, r);
        renderMapSidebar(panel, selectedId, currentView());
      });
    });
    if (backBtn) backBtn.addEventListener('click', deselect);

    // Sidebar always shows a list (the full unfiltered one by default), so
    // populate it immediately rather than waiting for a region click.
    renderMapSidebar(panel, selectedId, currentView());

    panel._mapRefreshSidebar = () => renderMapSidebar(panel, selectedId, currentView());
  }

  // html2canvas draws cross-origin <img> elements (CDN flags, the square's
  // logo) via a raw ctx.drawImage, which silently no-ops on a tainted
  // source instead of throwing -- the image just never appears. Pre-fetch
  // each one and swap its src for a same-origin data: URI before capture
  // sidesteps that entirely (see downloadRankingsImage).
  async function inlineImages(root) {
    const imgs = [...root.querySelectorAll('img')];
    await Promise.all(imgs.map(async (img) => {
      try {
        const resp = await fetch(img.src);
        const blob = await resp.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        img.src = dataUrl;
      } catch (_) {
        // Leave the original src; ignoreElements below drops it from the
        // render instead of leaving a broken/cross-origin image in place.
      }
    }));
  }

  // html2canvas doesn't honor object-fit on <img> (a longstanding upstream
  // limitation) -- it just stretches the source bitmap to fill the element's
  // full box, ignoring .prc-flag's object-fit: contain. Live, that CSS
  // letterboxes each flag to its own real aspect ratio inside the 1.5em x
  // 1.15em box (so e.g. the UK flag's wider ~2:1 shape renders smaller than
  // the box rather than stretched to fill it); in the export every flag was
  // instead coming out uniformly squashed to the box's own ~1.3:1 shape.
  // Bake the same contain math into real pixels instead: draw each flag
  // (already same-origin after inlineImages) onto a canvas sized to the
  // box's own rendered dimensions, scaled/centered exactly like
  // object-fit: contain would, and swap the <img> src for that -- so the
  // stretch has nothing left to distort. Must run after inlineImages (needs
  // a decodable same-origin/data: src) and after the clone is attached with
  // its final layout (needs real getBoundingClientRect() sizes).
  async function bakeFlagAspect(root) {
    const imgs = [...root.querySelectorAll('img.prc-flag')];
    await Promise.all(imgs.map(async (img) => {
      if (!img.complete) await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      if (!iw || !ih) return;
      const rect = img.getBoundingClientRect();
      const boxW = Math.max(1, Math.round(rect.width * 2));
      const boxH = Math.max(1, Math.round(rect.height * 2));
      const scale = Math.min(boxW / iw, boxH / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const canvas = document.createElement('canvas');
      canvas.width = boxW;
      canvas.height = boxH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, (boxW - dw) / 2, (boxH - dh) / 2, dw, dh);
      img.src = canvas.toDataURL('image/png');
    }));
  }

  // Captures the top 100 ranked cards passing the default min-games/max-RD
  // filter (same 5+/<=150 thresholds as the default view, regardless of
  // whatever the live min-games/max-RD/state selects are currently set to)
  // plus the .pr-square promo tile into an offscreen clone forced to the
  // 8-column desktop layout, so the exported image is consistent regardless
  // of the current viewport width or filter state.
  async function downloadRankingsImage(panel) {
    const grid = panel.querySelector('.pr-grid');
    if (!grid || !window.html2canvas) throw new Error('Power Ranking grid or html2canvas unavailable');
    // Custom fonts may not have finished loading yet, and this also ensures
    // the metrics fitCardNames() measures below are accurate.
    await document.fonts.ready;
    const square = grid.querySelector('.pr-square');
    const qualifying = [...grid.querySelectorAll(':scope > .pr-card')].filter((c) => {
      const games = parseInt(c.dataset.games || '0', 10);
      const rd = parseFloat(c.dataset.rd || '0');
      return games >= 5 && rd <= 150;
    });
    const cards = qualifying.slice(0, 100);
    const clone = document.createElement('div');
    // Carries the live rank-delta toggle state along into the export --
    // .show-rank-delta isn't #rankings-tab-scoped specifically so this plain
    // <body> child can match it too (see the CSS rule for why).
    clone.className = 'pr-grid pr-export-grid' + (panel.classList.contains('show-rank-delta') ? ' show-rank-delta' : '');
    clone.style.gridTemplateColumns = 'repeat(8, 1fr)';
    // Pinned to this specific width (rather than the live grid's current
    // width) so every download comes out identically sized -- this is
    // whatever .pr-grid measured on the developer's own screen, not a
    // computed/responsive value. Retune by hand if it ever needs to change.
    // box-sizing is forced back to content-box here (overriding the site's
    // global * { box-sizing: border-box } reset) so this width is the actual
    // content/column width, matching .pr-grid's own measured width exactly --
    // otherwise the padding below would eat into it and every card would
    // render slightly narrower than the live site's.
    clone.style.boxSizing = 'content-box';
    clone.style.width = '1472px';
    clone.style.padding = '24px';
    clone.style.background = '#050505';
    if (square) {
      const squareClone = square.cloneNode(true);
      squareClone.style.display = 'flex';
      clone.appendChild(squareClone);
    }
    // Cards already passed the games/RD check above, but may still carry a
    // hidden attribute from a live state-filter selection (cloneNode
    // preserves it, and left alone it'd collapse the clone to zero size) --
    // force every one of the top 100 visible and renumbered 1-100, since the
    // export always shows all locations regardless of the live state filter.
    cards.forEach((c, idx) => {
      const cardClone = c.cloneNode(true);
      cardClone.hidden = false;
      cardClone.classList.remove('filter-dim', 'uncertain');
      // Only the numeral, not the whole .prc-rank -- that would also wipe
      // out the sibling .rank-delta badge (and rank-plain's color class),
      // which should survive the renumbering since the rating-point change
      // it shows isn't tied to rank position.
      const rankEl = cardClone.querySelector('.prc-rank .rank-plain');
      if (rankEl) rankEl.textContent = idx + 1;
      clone.appendChild(cardClone);
    });
    document.body.appendChild(clone);
    // html2canvas's own gradient renderer doesn't size a radial-gradient's
    // implicit farthest-corner extent correctly (tried it explicit, tried an
    // explicit percentage size, tried hand-deriving and painting the
    // ellipse ourselves via Canvas2D -- none matched the live page's actual
    // rendered gradient). Instead of reimplementing it at all, literally
    // copy the real thing: render an actual .pr-card.card-green/.card-purple
    // through an SVG foreignObject, which uses the browser's own genuine CSS
    // engine (not a reimplementation), rasterize that to a bitmap, and use
    // it as a background-image -- html2canvas draws real images reliably,
    // just not live CSS gradients.
    const glowCache = {};
    // Same as .pr-card.card-green/.card-purple's CSS -- inlined directly
    // rather than referenced by class, since the foreignObject below is
    // serialized to a standalone SVG document with no access to the page's
    // external stylesheet (a class name alone rendered with no styling at
    // all, confirmed by sampling the result: flat, no color whatsoever).
    const glowBackgrounds = {
      'card-green': 'radial-gradient(ellipse at 20% 0%, rgba(62,255,139,0.22) 0%, #0f0f0f 65%)',
      'card-purple': 'radial-gradient(ellipse at 20% 0%, rgba(176,79,255,0.22) 0%, #0f0f0f 65%)',
    };
    async function glowDataUri(cardClass, w, h) {
      const key = cardClass + '|' + w + '|' + h;
      if (glowCache[key]) return glowCache[key];
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      const fo = document.createElementNS(svgNS, 'foreignObject');
      fo.setAttribute('width', '100%');
      fo.setAttribute('height', '100%');
      const div = document.createElement('div');
      div.style.width = w + 'px';
      div.style.height = h + 'px';
      div.style.margin = '0';
      div.style.background = glowBackgrounds[cardClass];
      fo.appendChild(div);
      svg.appendChild(fo);
      const svgStr = new XMLSerializer().serializeToString(svg);
      const svgUri = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = svgUri; });
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f0f0f';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0);
      const uri = canvas.toDataURL('image/png');
      glowCache[key] = uri;
      return uri;
    }
    await Promise.all([...clone.querySelectorAll('.pr-card')].map(async (c) => {
      const isGreen = c.classList.contains('card-green');
      const isPurple = c.classList.contains('card-purple');
      if (isGreen || isPurple) {
        const rect = c.getBoundingClientRect();
        const uri = await glowDataUri(isGreen ? 'card-green' : 'card-purple', rect.width, rect.height);
        c.style.background = 'url(' + uri + ')';
        c.style.backgroundSize = '100% 100%';
      } else {
        c.style.background = '#0f0f0f';
      }
    }));
    // cloneNode copies each name's live inline font-size (set by
    // fitCardNames() against the ORIGINAL grid's column width) verbatim --
    // that size is wrong whenever the live grid's current width doesn't
    // match this clone's pinned export width, so names clipped fine on-page
    // can overflow their card here. Re-fit against the clone's actual width
    // now that it's attached to the DOM.
    fitCardNames(clone);
    await inlineImages(clone);
    await bakeFlagAspect(clone);
    // Not wrapped in try/finally -- the caller (the download button's click
    // handler) needs a genuine rejection on failure so it knows to flip back
    // to a clickable, non-"loading" state rather than staying stuck.
    try {
      const canvas = await html2canvas(clone, {
        backgroundColor: '#050505',
        scale: 2,
        useCORS: true,
        ignoreElements: (node) => node.tagName === 'IMG' && !node.src.startsWith('data:'),
      });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Local date parts (not toISOString(), which is UTC and can read as
      // tomorrow/yesterday depending on the visitor's timezone) -- date
      // only, no time, so repeated same-day downloads share one filename.
      const now = new Date();
      const dateStamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      a.download = 'deathball-power-rankings-' + dateStamp + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      clone.remove();
    }
  }

  // Two download buttons exist in the DOM at once -- .download-btn-boxed
  // (desktop, inside the Power Rankings tab-controls row) and
  // .download-btn-icon (mobile, top-right of .page-title-row, so it stays
  // reachable regardless of whether the mobile Options panel is collapsed)
  // -- CSS shows exactly one of them per viewport (see writeCss), but both
  // need the same show/hide state, which depends on which tab and which
  // view (Grid vs Table) are active. Both enableTabs (tab switch) and
  // enableViewToggle (view switch) call this after they change either one.
  function updateDownloadVisibility() {
    const btns = document.querySelectorAll('.download-btn');
    if (!btns.length) return;
    const rankingsPanel = document.getElementById('rankings-tab');
    const rankingsActive = !!rankingsPanel && rankingsPanel.classList.contains('active');
    const gridActive = !!rankingsPanel && !!rankingsPanel.querySelector('.view-btn[data-view="grid"].active');
    const hide = !(rankingsActive && gridActive);
    btns.forEach((btn) => { btn.hidden = hide; });
  }

  function enableViewToggle(panel) {
    const buttons = [...panel.querySelectorAll('.view-btn')];
    if (!buttons.length) return;
    const grid = panel.querySelector('.pr-grid');
    const table = panel.querySelector('table');
    const toggleEl = panel.querySelector('.view-toggle');
    const indicator = panel.querySelector('.view-toggle-indicator');
    // The rank-delta badge only ever exists in the card markup (see
    // rankDeltaHtml's call sites), so its show/hide pill is meaningless --
    // and would sit there inert -- once the Table view is active.
    const rankDeltaToggle = panel.querySelector('.rank-delta-toggle');
    // Loading state disables the button entirely (so a second click can't
    // start a second concurrent export mid-generation, which is otherwise
    // easy to trigger since generation takes a couple of seconds and gave
    // no visible feedback before this). A failed attempt clears back to the
    // normal enabled state (not "loading") so the button is clickable again
    // to retry, rather than getting stuck disabled forever. Only one of the
    // two buttons is ever visible/clickable at once (see writeCss), but the
    // listener is attached to both independently -- each just drives its
    // own loading/failed state and the same downloadRankingsImage call.
    document.querySelectorAll('.download-btn').forEach((downloadBtn) => {
      const downloadLabel = downloadBtn.querySelector('.download-btn-label');
      downloadBtn.addEventListener('click', async () => {
        if (downloadBtn.disabled) return;
        downloadBtn.disabled = true;
        downloadBtn.classList.remove('failed');
        downloadBtn.classList.add('loading');
        if (downloadLabel) downloadLabel.textContent = 'Preparing…';
        try {
          await downloadRankingsImage(panel);
          if (downloadLabel) downloadLabel.textContent = 'Download PR';
        } catch (err) {
          downloadBtn.classList.add('failed');
          if (downloadLabel) downloadLabel.textContent = 'Failed — Retry';
        } finally {
          downloadBtn.disabled = false;
          downloadBtn.classList.remove('loading');
        }
      });
    });
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.dataset.view;
        if (grid) grid.style.display = view === 'grid' ? '' : 'none';
        if (table) table.style.display = view === 'table' ? '' : 'none';
        updateDownloadVisibility();
        // Desktop collapses this pill entirely on Table view (see
        // .rank-delta-toggle[hidden] in writeCss); mobile overrides that
        // same [hidden] rule back to display:flex + visibility:hidden so it
        // still reserves its space instead of shifting the Min Games/Max RD
        // controls next to it.
        if (rankDeltaToggle) rankDeltaToggle.hidden = view !== 'grid';
        moveIndicator(indicator, toggleEl, btn);
        // Also refreshes the "Click a column header to sort." hint for the
        // view just switched to.
        applyFilters(panel);
      });
    });
    const activeBtn = buttons.find((b) => b.classList.contains('active'));
    updateDownloadVisibility();
    if (rankDeltaToggle) rankDeltaToggle.hidden = !activeBtn || activeBtn.dataset.view !== 'grid';
    moveIndicator(indicator, toggleEl, activeBtn);
  }

  // Show/Hide pill for the rank-delta (up/down/new) badge on Power Ranking
  // cards -- see #rankings-tab.show-rank-delta in the generated CSS, which
  // is the only thing that actually reveals .rank-delta. Off by default
  // (see the "hide" button's initial "active" class in writeHtml()) so the
  // badge doesn't compete for attention on the grid every time.
  function enableRankDeltaToggle(panel) {
    const toggleEl = panel.querySelector('.rank-delta-toggle');
    if (!toggleEl) return;
    const buttons = [...toggleEl.querySelectorAll('.delta-btn')];
    const indicator = toggleEl.querySelector('.view-toggle-indicator');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        panel.classList.toggle('show-rank-delta', btn.dataset.delta === 'show');
        moveIndicator(indicator, toggleEl, btn);
      });
    });
    const activeBtn = buttons.find((b) => b.classList.contains('active'));
    moveIndicator(indicator, toggleEl, activeBtn);
  }

  // Rebuilds .pr-card/.pr-card accents and the rank-delta badge from raw
  // row data -- mirrors cardAccent()/rankDeltaState()/rankDeltaHtml() in
  // aggregate_players.js. Kept in sync by hand: the "View rankings at"
  // dropdown (PR_HISTORY, see enablePrHistorySelect below) only ships each
  // checkpoint's *data*, not pre-rendered HTML, so switching checkpoints
  // re-renders the grid/table client-side the same way the map tab's
  // sidebar re-renders from MAP_REGION_DATA.
  function prCardAccent(id, colorOverride) {
    if (colorOverride === 'green' || colorOverride === 'purple') return 'card-' + colorOverride;
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
    return (h & 1) ? 'card-purple' : 'card-green';
  }

  function prRankDeltaState(row) {
    if (row.isNew) return 'new';
    if (!row.placementChange) return null;
    return row.placementChange > 0 ? 'up' : 'down';
  }

  function prRankDeltaBadge(row) {
    const state = prRankDeltaState(row);
    if (!state) return null;
    const span = document.createElement('span');
    if (state === 'new') {
      span.className = 'rank-delta rank-delta-new';
      span.textContent = 'NEW';
    } else if (state === 'up') {
      span.className = 'rank-delta rank-delta-up';
      span.textContent = '▲' + row.placementChange;
    } else {
      span.className = 'rank-delta rank-delta-down';
      span.textContent = '▼' + Math.abs(row.placementChange);
    }
    return span;
  }

  function prFlagImg(flag, className) {
    if (!flag) return null;
    const img = document.createElement('img');
    img.className = className;
    img.src = flag.src;
    img.title = flag.title;
    img.alt = flag.title;
    return img;
  }

  function buildRankingCard(row, meta, rank) {
    const card = document.createElement('div');
    card.className = 'pr-card ' + prCardAccent(row.id, meta.color) + (row.uncertain ? ' uncertain' : '');
    card.dataset.games = row.games;
    card.dataset.rd = row.rd;
    if (meta.state) card.dataset.state = meta.state;

    const top = document.createElement('div');
    top.className = 'prc-top';

    const rankSpan = document.createElement('span');
    rankSpan.className = 'prc-rank';
    const rankPlain = document.createElement('span');
    const deltaState = prRankDeltaState(row);
    rankPlain.className = 'rank-plain' + (deltaState ? ' rank-plain-' + deltaState : '');
    rankPlain.textContent = rank;
    rankSpan.appendChild(rankPlain);
    const badge = prRankDeltaBadge(row);
    if (badge) rankSpan.appendChild(badge);
    top.appendChild(rankSpan);

    const nameEl = document.createElement(meta.href ? 'a' : 'span');
    nameEl.className = 'prc-name';
    nameEl.title = meta.name;
    nameEl.textContent = meta.name;
    if (meta.href) nameEl.href = meta.href;
    top.appendChild(nameEl);

    const flagImg = prFlagImg(meta.flag, 'prc-flag');
    if (flagImg) top.appendChild(flagImg);

    card.appendChild(top);

    const stats = document.createElement('div');
    stats.className = 'prc-stats';
    const addVal = (text, cls) => {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      stats.appendChild(span);
    };
    addVal(String(row.r), 'prc-val');
    addVal('±', 'prc-dim');
    addVal(String(row.rd), 'prc-val');
    addVal('|', 'prc-sep');
    addVal(String(Math.round(row.winPct * 100)), 'prc-val');
    addVal('W%', 'prc-dim');
    addVal('|', 'prc-sep');
    addVal(String(row.games), 'prc-val');
    addVal('gp', 'prc-dim');
    if (meta.locAbbr) {
      const abbrSpan = document.createElement('span');
      abbrSpan.className = 'prc-loc-abbr';
      abbrSpan.title = meta.location;
      abbrSpan.textContent = meta.locAbbr;
      stats.appendChild(abbrSpan);
    }
    card.appendChild(stats);
    return card;
  }

  function buildRankingTableRow(row, meta, rank) {
    const tr = document.createElement('tr');
    tr.dataset.games = row.games;
    tr.dataset.rd = row.rd;
    if (meta.state) tr.dataset.state = meta.state;
    if (row.uncertain) tr.className = 'uncertain';

    const rankTd = document.createElement('td');
    rankTd.className = 'rank-num';
    rankTd.textContent = rank;
    tr.appendChild(rankTd);

    const nameTd = document.createElement('td');
    const nameEl = document.createElement(meta.href ? 'a' : 'span');
    if (meta.href) nameEl.href = meta.href;
    nameEl.textContent = meta.name;
    nameTd.appendChild(nameEl);
    tr.appendChild(nameTd);

    const addNumeric = (text, sort) => {
      const td = document.createElement('td');
      td.className = 'numeric';
      if (sort !== undefined) td.dataset.sort = sort;
      td.textContent = text;
      tr.appendChild(td);
    };
    addNumeric(String(row.r));
    addNumeric('±' + row.rd, row.rd);
    addNumeric(String(row.wins), row.wins);
    addNumeric(String(row.losses), row.losses);
    addNumeric(String(row.games), row.games);
    addNumeric((row.winPct * 100).toFixed(1) + '%', row.winPct);

    const lastActiveTd = document.createElement('td');
    lastActiveTd.textContent = meta.lastActive || '';
    tr.appendChild(lastActiveTd);

    const locTd = document.createElement('td');
    locTd.className = 'col-location';
    locTd.dataset.sort = meta.locationSort;
    const flagImg = prFlagImg(meta.flag, 'loc-flag');
    if (flagImg) locTd.appendChild(flagImg);
    locTd.appendChild(document.createTextNode(meta.location));
    tr.appendChild(locTd);

    return tr;
  }

  // Mirrors toClientRow()'s array order in aggregate_players.js:
  // [id, r, rd, wins, losses, games, isNew, placementChange]. winPct/uncertain
  // aren't shipped (cheap to recompute) so they're filled back in here.
  function normalizeRow(arr) {
    const [id, r, rd, wins, losses, games, isNew, placementChange] = arr;
    return {
      id, r, rd, wins, losses, games,
      winPct: games > 0 ? wins / games : 0,
      uncertain: rd > PR_UNCERTAIN_RD_THRESHOLD,
      isNew, placementChange,
    };
  }

  function renderRankingHistory(panel, checkpoint) {
    const grid = panel.querySelector('.pr-grid');
    const tbody = panel.querySelector('table tbody');
    const rows = checkpoint.rows.map(normalizeRow);
    if (grid) {
      [...grid.querySelectorAll(':scope > .pr-card')].forEach((el) => el.remove());
      rows.forEach((row, i) => grid.appendChild(buildRankingCard(row, PR_META[row.id] || {}, i + 1)));
    }
    if (tbody) {
      tbody.innerHTML = '';
      rows.forEach((row, i) => tbody.appendChild(buildRankingTableRow(row, PR_META[row.id] || {}, i + 1)));
    }
    applyFilters(panel);
    fitCardNames(panel);
  }

  // Populates the Rankings tab's "View rankings at" dropdown from PR_HISTORY
  // (one entry per tournament group, chronological) -- most-recent first,
  // with a clock icon marking the current/latest entry. Selecting an older
  // entry swaps the grid/table to that point-in-time standings; filters and
  // the download button both operate on whatever's currently rendered, so
  // they keep working unchanged.
  function enablePrHistorySelect(panel) {
    const select = panel.querySelector('.pr-history-select');
    const label = select ? select.closest('label') : null;
    if (!select || PR_HISTORY.length < 2) {
      if (label) label.hidden = true;
      return;
    }
    for (let i = PR_HISTORY.length - 1; i >= 0; i--) {
      const checkpoint = PR_HISTORY[i];
      const opt = document.createElement('option');
      opt.value = String(i);
      const dateLabel = checkpoint.dateLabel ? checkpoint.dateLabel + ' - ' : '';
      opt.textContent = (checkpoint.isLatest ? '🕒 ' : '') + dateLabel + checkpoint.label;
      if (checkpoint.isLatest) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      const checkpoint = PR_HISTORY[parseInt(select.value, 10)];
      if (checkpoint) renderRankingHistory(panel, checkpoint);
    });
  }

  function initPanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    populateStateFilter(panel);
    applyFilters(panel);
    if (panelId === 'rankings-tab') enablePrHistorySelect(panel);
    panel.querySelectorAll('.min-games-select, .max-rd-select, .state-filter-select').forEach((el) => {
      el.addEventListener('change', () => applyFilters(panel));
    });
    enableViewToggle(panel);
    enableRankDeltaToggle(panel);
    document.fonts.ready.then(() => fitCardNames(panel));
  }

  // Both the Events tab grid and the pr-square's "Next Tournament" callout
  // are baked at generation time using the build machine's today (see
  // sortedUpcomingEvents() / buildEventsTabHtml() in aggregate_players.js).
  // If the site isn't regenerated the same day an event's date passes, the
  // static HTML still shows it as upcoming. Re-filter both against the
  // *visitor's* today here so a stale build still self-corrects in the
  // browser instead of waiting on a rebuild.
  function setupLiveEventFiltering() {
    // Built from local date parts, not toISOString(), for the same reason
    // as todayIso() server-side: UTC parsing can read as tomorrow/yesterday
    // depending on the visitor's timezone.
    const d = new Date();
    const today = \`\${d.getFullYear()}-\${String(d.getMonth() + 1).padStart(2, '0')}-\${String(d.getDate()).padStart(2, '0')}\`;

    const grid = document.getElementById('events-grid');
    if (grid) {
      const cards = [...grid.querySelectorAll('.event-card[data-date]')];
      cards.forEach((card) => { card.hidden = card.dataset.date < today; });
      const anyVisible = cards.some((card) => !card.hidden);
      grid.hidden = !anyVisible;
      const empty = document.getElementById('events-empty');
      const footer = document.getElementById('events-footer');
      if (empty) empty.hidden = anyVisible;
      if (footer) footer.hidden = !anyVisible;
    }

    const candidatesWrap = document.getElementById('pr-square-next-candidates');
    if (candidatesWrap) {
      const candidates = [...candidatesWrap.querySelectorAll('.next-event-candidate[data-date]')];
      const chosen = candidates.find((c) => c.dataset.date >= today);
      candidates.forEach((c) => { c.hidden = c !== chosen; });
      const single = document.getElementById('pr-square-latest-single');
      const plural = document.getElementById('pr-square-latest-plural');
      if (single) single.hidden = !chosen;
      if (plural) plural.hidden = !!chosen;
    }
  }

  document.querySelectorAll('table[data-sortable]').forEach(enableSorting);
  enableTabs();
  enableTabsMenu();
  enableOptionsToggle();
  initPanel('players-tab');
  initPanel('rankings-tab');
  enableMapToggle(document.getElementById('map-tab'));
  enableMapRegions(document.getElementById('map-tab'));
  setupLiveEventFiltering();

  // Every indicator above was positioned/sized against whatever font was
  // rendering at that moment — on first paint that's often the fallback
  // font, since Rajdhani/Orbitron load async, so the underline/pill can end
  // up too wide or narrow until something else (a click) recomputes it.
  // Re-measure the tab underline and any currently-visible view-toggle pill
  // once the real fonts are in so page load always lands on the right size.
  document.fonts.ready.then(() => {
    moveIndicator(document.querySelector('.tab-underline'), document.querySelector('.tabs'), document.querySelector('.tab-button.active'));
    document.querySelectorAll('.view-toggle').forEach((toggleEl) => {
      if (!toggleEl.offsetWidth) return; // hidden panel — its own tab click handler will fix this when it opens
      const indicator = toggleEl.querySelector('.view-toggle-indicator');
      const active = toggleEl.querySelector('.view-btn.active, .delta-btn.active');
      if (indicator && active) moveIndicator(indicator, toggleEl, active);
    });
  });
})();
`;
  fs.writeFileSync(path.join(REPO_ROOT, 'index.js'), js);
}

// Renders the Upcoming Events tab body: a 3-wide grid of event cards (each
// a link out to registration/bracket), sorted soonest-first, with events
// whose date has already passed dropped entirely -- there's no "past
// events" view, so once a date is gone it should just disappear rather than
// need manual cleanup from upcoming-events.json.
// Shared by the Upcoming Events tab and the pr-square's "Next Tournament"
// callout so both agree on what counts as upcoming and in what order.
//
// This filters against the *build machine's* today, which goes stale the
// moment a real-world date crosses an event's date without a regeneration
// in between -- the site is static and may not get rebuilt same-day. Each
// event card still carries its own data-date so client-side JS (see
// setupLiveEventFiltering() in writeJs()) can re-filter against the
// *visitor's* today at page-load time and hide anything that's since
// passed, without needing a rebuild.
function sortedUpcomingEvents(events) {
  const today = todayIso();
  return events
    .filter((e) => (e.date || '') >= today)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}

function buildEventsTabHtml(events) {
  const upcoming = sortedUpcomingEvents(events);
  const isEmpty = upcoming.length === 0;

  const cards = upcoming.map((e) => {
    const cityState = [e.city, e.state].filter(Boolean).join(', ');
    const venueLine = [e.location, cityState].filter(Boolean).map(escapeHtml).join(' &middot; ');
    const flag = flagForInfo({ city: e.city, state: e.state, country: e.country });
    const flagImg = flag ? `<img class="loc-flag" src="${escapeHtml(flag.src)}" title="${escapeHtml(flag.title)}" alt="${escapeHtml(flag.title)}">` : '';
    // "color" is an "H, S%, L%" triple in the JSON (e.g. "205, 80%, 55%"),
    // fed straight into hsl()/hsla() via CSS custom properties so the card's
    // background/border/date-color all derive from one hue instead of
    // needing three separate colors picked by hand. Falls back to the
    // default amber via each hsla()'s third var() argument (see CSS) when
    // no color is set, so the style attribute is only emitted when needed.
    const hsl = parseHsl(e.color);
    const styleAttr = hsl ? ` style="--eh:${hsl.h};--es:${hsl.s};--el:${hsl.l}"` : '';
    const imageImg = e.image ? `<div class="event-image-wrap"><img class="event-image" src="${escapeHtml(e.image)}" alt=""></div>` : '';
    // data-date lets client-side JS (setupLiveEventFiltering() in writeJs())
    // re-check this card against the *visitor's* today at page-load time --
    // the server-side filter above only reflects the build machine's today,
    // which goes stale between rebuilds.
    return `<a class="event-card${e.image ? ' has-image' : ''}" data-date="${escapeHtml(e.date || '')}" href="${escapeHtml(e.link || '')}" target="_blank" rel="noopener"${styleAttr}>
  <div class="event-body">
    <div class="event-date">${escapeHtml(formatDateHuman(e.date))}</div>
    <div class="event-name">${escapeHtml(e.name || '')}</div>
    ${venueLine ? `<div class="event-venue">${flagImg}${venueLine}</div>` : ''}
  </div>
  ${imageImg}
</a>`;
  }).join('\n');

  // Grid/footer/empty-message are all always emitted (rather than one or
  // the other) so setupLiveEventFiltering() can toggle their [hidden] state
  // after re-filtering client-side, instead of needing to rebuild markup.
  return `<div class="events-grid"${isEmpty ? ' hidden' : ''} id="events-grid">
${cards}
</div>
<div class="events-empty"${isEmpty ? '' : ' hidden'} id="events-empty">No future events&hellip; try scheduling one!</div>
<div class="events-footer"${isEmpty ? ' hidden' : ''} id="events-footer">That's all for now, try scheduling an event!</div>`;
}

function teamKeyFor(idA, idB) {
  return [idA, idB].sort().join('::');
}

// For a doubles tournament, maps each standings entry's canonical team name
// (as produced by buildStandings/resolveIdentity) to its two resolved player
// identities -- shared by buildPlayerHistories's doubles branch and
// buildDoublesHistories, which both need a team's *per-tournament* standing
// (rank/record), unlike buildDoublesTeams' simpler cross-tournament tally.
function resolveDoublesTeamPairs(t) {
  const pairByCanonName = new Map();
  const consider = (raw) => {
    if (!raw) return;
    const canon = resolveIdentity(raw, t.url).name;
    if (pairByCanonName.has(canon)) return;
    const parts = parseTeamName(raw);
    if (!parts) return;
    const a = resolveIdentity(parts[0], t.url);
    const b = resolveIdentity(parts[1], t.url);
    if (!a.id || !b.id || a.id === b.id) return;
    pairByCanonName.set(canon, [a, b]);
  };
  for (const p of t.participantList) consider(p.name);
  for (const m of t.matches) { consider(m.winnerName); consider(m.loserName); }
  return pairByCanonName;
}

// Ensures every doubles participant has a `players` map entry (even someone
// who has never played a singles match at all) so they get a slug, a player
// page, and a row on the Players tab -- but only ever touches `tournaments`
// (for the tab's tournament count/list), never wins/losses/games, which stay
// whatever recordMatch/singles play already gave them (0 for a doubles-only
// player). A 0-games player is automatically excluded from the PR tab by
// buildRankingRows' existing `games > 0` filter, so this alone is enough to
// keep doubles-only players off the rankings without a separate guard.
function registerDoublesParticipants(allTournaments, players) {
  for (const t of allTournaments) {
    if (!t.isDoubles) continue;
    for (const [a, b] of resolveDoublesTeamPairs(t).values()) {
      for (const identity of [a, b]) {
        getPlayer(players, identity).tournaments.set(t.url, t.label);
      }
    }
  }
}

// Aggregates doubles-tournament rosters/matches into one record per team (an
// unordered pair of two existing player identities): tournaments entered,
// wins, losses. This is the only place doubles results are counted anywhere
// on the site — the Glicko engine and singles stats never see them (see the
// isDoubles guards in processChronologically/buildPlayerHistories/
// buildPlayerStats). Powers the Doubles tab.
function buildDoublesTeams(allTournaments) {
  const teams = new Map();
  const ensureTeam = (a, b) => {
    const key = teamKeyFor(a.id, b.id);
    if (!teams.has(key)) teams.set(key, { key, players: [a, b], tournaments: new Map(), wins: 0, losses: 0 });
    return teams.get(key);
  };

  for (const t of allTournaments) {
    if (!t.isDoubles) continue;

    for (const p of t.participantList) {
      const parts = parseTeamName(p.name);
      if (!parts) continue;
      const a = resolveIdentity(parts[0], t.url);
      const b = resolveIdentity(parts[1], t.url);
      if (!a.id || !b.id || a.id === b.id) continue;
      ensureTeam(a, b).tournaments.set(t.url, t.label);
    }

    for (const m of t.matches) {
      if (!m.winnerName || !m.loserName) continue;
      const winnerParts = parseTeamName(m.winnerName);
      const loserParts = parseTeamName(m.loserName);
      if (!winnerParts || !loserParts) continue;
      const winA = resolveIdentity(winnerParts[0], t.url);
      const winB = resolveIdentity(winnerParts[1], t.url);
      const loseA = resolveIdentity(loserParts[0], t.url);
      const loseB = resolveIdentity(loserParts[1], t.url);
      if (winA.id === winB.id || loseA.id === loseB.id) continue;
      const winnerTeam = ensureTeam(winA, winB);
      winnerTeam.tournaments.set(t.url, t.label);
      winnerTeam.wins += 1;
      const loserTeam = ensureTeam(loseA, loseB);
      loserTeam.tournaments.set(t.url, t.label);
      loserTeam.losses += 1;
    }
  }

  return [...teams.values()]
    .map((team) => ({
      key: team.key,
      players: team.players,
      tournamentCount: team.tournaments.size,
      wins: team.wins,
      losses: team.losses,
    }))
    .sort((a, b) => b.wins - a.wins || (b.wins - b.losses) - (a.wins - a.losses));
}

// Per-player breakdown of doubles results by partner, for the player page's
// "Doubles" section: Map<playerId, { partners: Map<partnerId, { id, name,
// entries: [{ url, slug, label, date, rank, totalEntrants, wins, losses }] }> }>
// -- entries is every tournament that player and that specific partner
// entered together, each with the team's own rank/record in that event.
function buildDoublesHistories(allTournaments) {
  const byPlayer = new Map();
  const ensure = (id) => {
    if (!byPlayer.has(id)) byPlayer.set(id, { partners: new Map() });
    return byPlayer.get(id);
  };

  for (const t of allTournaments) {
    if (!t.isDoubles) continue;
    const standings = buildStandings(t);
    const pairsByCanonName = resolveDoublesTeamPairs(t);

    for (const s of standings) {
      const pair = pairsByCanonName.get(s.name);
      if (!pair) continue;
      const [a, b] = pair;
      for (const [self, partner] of [[a, b], [b, a]]) {
        const rec = ensure(self.id);
        if (!rec.partners.has(partner.id)) rec.partners.set(partner.id, { id: partner.id, name: partner.name, entries: [] });
        rec.partners.get(partner.id).entries.push({
          url: t.url, slug: t.slug, label: t.label, date: t.date,
          rank: s.rank, totalEntrants: standings.length, wins: s.wins, losses: s.losses,
        });
      }
    }
  }

  return byPlayer;
}

function buildDoublesTabHtml(doublesTeams) {
  if (doublesTeams.length === 0) {
    return `<p class="doubles-empty">No doubles tournaments yet&hellip; results will show up here once one gets added.</p>`;
  }
  const cards = doublesTeams.map((team) => {
    const names = team.players.map((p) => {
      const href = playerHref(p.id, '');
      const flagImg = playerFlagImg(p.id, p.name);
      return href ? `<a href="${escapeHtml(href)}">${flagImg}${escapeHtml(p.name)}</a>` : `<span>${flagImg}${escapeHtml(p.name)}</span>`;
    }).join(' <span class="doubles-amp">&amp;</span> ');
    const games = team.wins + team.losses;
    const winPct = games > 0 ? Math.round((team.wins / games) * 100) : 0;
    const accent = teamCardAccent(team.players[0], team.players[1]);
    return `<div class="doubles-card ${accent}">
  <div class="doubles-card-names">${names}</div>
  <div class="doubles-card-stats"><span>${team.tournamentCount} tournament${team.tournamentCount === 1 ? '' : 's'}</span><span class="doubles-sep">&middot;</span><span>${team.wins}-${team.losses} (${winPct}%)</span></div>
</div>`;
  }).join('\n');
  return `<div class="doubles-grid">
${cards}
</div>`;
}

function writeHtml(playerRows, allTournaments, rankingRows, mapRegions, mapAllPlayers, mapAllTournaments, rankingHistory, doublesTeams) {
  const playerTableRows = playerRows.map((p) => {
    const tournamentLinks = p.tournaments
      .map((t) => `<a href="tournaments/${escapeHtml(t.slug)}.html"${t.location ? ` title="${escapeHtml(t.location)}"` : ''}>${escapeHtml(t.label)}</a>`)
      .join(', ');
    const nameCell = playerHref(p.id, '') ? `<a href="${escapeHtml(playerHref(p.id, ''))}">${escapeHtml(p.name)}</a>` : escapeHtml(p.name);
    return `<tr${p.state ? ` data-state="${escapeHtml(p.state)}"` : ''}>
      <td>${nameCell}</td>
      <td data-sort="${escapeHtml(p.locationSort)}" class="col-location">${p.flag ? `<img class="loc-flag" src="${escapeHtml(p.flag.src)}" title="${escapeHtml(p.flag.title)}" alt="${escapeHtml(p.flag.title)}">` : ''}${escapeHtml(p.location)}</td>
      <td class="numeric" data-sort="${p.wins}">${p.wins}</td>
      <td class="numeric" data-sort="${p.losses}">${p.losses}</td>
      <td class="numeric" data-sort="${p.games}">${p.games}</td>
      <td class="numeric" data-sort="${p.winPct}">${(p.winPct * 100).toFixed(1)}%</td>
      <td class="numeric">${escapeHtml(p.lastActive)}</td>
      <td class="numeric" data-sort="${p.tournaments.length}">${p.tournaments.length}</td>
      <td>${tournamentLinks}</td>
    </tr>`;
  }).join('\n');

  const tournamentTableRows = [...allTournaments]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map((t) => `<tr>
      <td><a href="tournaments/${escapeHtml(t.slug)}.html">${escapeHtml(t.label)}</a><a class="ext-link" href="${escapeHtml(t.url)}" target="_blank" rel="noopener" title="View original">&#8599;</a>${t.isDoubles ? ' <span class="doubles-pill">Doubles</span>' : ''}</td>
      <td data-sort="${t.date}">${escapeHtml(t.date)}</td>
      <td>${locationHtml(t.locationDisplay)}</td>
      <td>${escapeHtml(t.source)}</td>
      <td class="numeric" data-sort="${t.participants}">${t.participants}</td>
      <td class="numeric" data-sort="${t.matchCount}">${t.matchCount}</td>
    </tr>`).join('\n');

  const rankingTableRows = rankingRows.map((p, i) => {
    const nameCell = playerHref(p.id, '') ? `<a href="${escapeHtml(playerHref(p.id, ''))}">${escapeHtml(p.name)}</a>` : escapeHtml(p.name);
    return `<tr data-games="${p.games}" data-rd="${Math.round(p.rd)}"${p.state ? ` data-state="${escapeHtml(p.state)}"` : ''}${p.uncertain ? ' class="uncertain"' : ''}>
      <td class="rank-num">${i + 1}</td>
      <td>${nameCell}</td>
      <td class="numeric">${Math.round(p.r)}</td>
      <td class="numeric" data-sort="${p.rd.toFixed(4)}">&#xB1;${Math.round(p.rd)}</td>
      <td class="numeric" data-sort="${p.wins}">${p.wins}</td>
      <td class="numeric" data-sort="${p.losses}">${p.losses}</td>
      <td class="numeric" data-sort="${p.games}">${p.games}</td>
      <td class="numeric" data-sort="${p.winPct}">${(p.winPct * 100).toFixed(1)}%</td>
      <td class="numeric">${escapeHtml(p.lastActive)}</td>
      <td data-sort="${escapeHtml(p.locationSort)}" class="col-location">${p.flag ? `<img class="loc-flag" src="${escapeHtml(p.flag.src)}" title="${escapeHtml(p.flag.title)}" alt="${escapeHtml(p.flag.title)}">` : ''}${escapeHtml(p.location)}</td>
    </tr>`;
  }).join('\n');

  const rankingCardItems = rankingRows.map((p, i) => {
    const flagImg = p.flag ? `<img class="prc-flag" src="${escapeHtml(p.flag.src)}" title="${escapeHtml(p.flag.title)}" alt="${escapeHtml(p.flag.title)}">` : '';
    const abbrSpan = p.locAbbr ? `<span class="prc-loc-abbr" title="${escapeHtml(p.location)}">${escapeHtml(p.locAbbr)}</span>` : '';
    const href = playerHref(p.id, '');
    const nameSpan = href
      ? `<a class="prc-name" href="${escapeHtml(href)}" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</a>`
      : `<span class="prc-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>`;
    return `<div class="pr-card ${cardAccent(p.id, p.color)}${p.uncertain ? ' uncertain' : ''}" data-games="${p.games}" data-rd="${Math.round(p.rd)}"${p.state ? ` data-state="${escapeHtml(p.state)}"` : ''}>
<div class="prc-top">
  <span class="prc-rank"><span class="rank-plain${rankDeltaState(p) ? ` rank-plain-${rankDeltaState(p)}` : ''}">${i + 1}</span>${rankDeltaHtml(p)}</span>${nameSpan}
  ${flagImg}
</div>
<div class="prc-stats"><span class="prc-val">${Math.round(p.r)}</span><span class="prc-dim">&#xB1;</span><span class="prc-val">${Math.round(p.rd)}</span><span class="prc-sep">|</span><span class="prc-val">${Math.round(p.winPct * 100)}</span><span class="prc-dim">W%</span><span class="prc-sep">|</span><span class="prc-val">${p.games}</span><span class="prc-dim">gp</span>${abbrSpan}</div>
</div>`;
  }).join('\n');

  // Sits in the middle of the grid at the 8-column breakpoint, its corners
  // landing exactly on cards 43-46 (top) and 91-94 (bottom) — see the
  // .pr-square CSS comment for the row/column math. Always shown for now;
  // remove this element (and the CSS block) once the design's approved.
  const now = new Date();
  const totalMatches = allTournaments.reduce((sum, t) => sum + (t.matchCount || 0), 0);
  // When there's a scheduled event on file, swap the usual 3-item "latest
  // tournaments" list for two small groups -- a single-item "Latest
  // Tournament" above a "Next Tournament" callout (soonest upcoming.json
  // entry) -- instead of a third stale result nobody asked for.
  //
  // All three groups below are always emitted, tagged with data-date where
  // relevant, and toggled via [hidden] by setupLiveEventFiltering() in
  // writeJs() at page-load time against the *visitor's* today -- like the
  // Events tab, this is baked at build time using the build machine's today
  // (sortedUpcomingEvents), which goes stale once a real-world date crosses
  // the chosen event's date without a rebuild in between.
  const upcomingSorted = sortedUpcomingEvents(upcomingEvents);
  const nextEvent = upcomingSorted[0];
  const latestTournament = allTournaments[allTournaments.length - 1];
  const latestSingleHtml = latestTournament
    ? `<div class="pr-square-latest-group" id="pr-square-latest-single"${nextEvent ? '' : ' hidden'}>
  <div class="pr-square-label">Latest Tournament</div>
  <div class="pr-square-latest-item">${escapeHtml(latestTournament.label)} &mdash; ${formatDateHuman(latestTournament.date)}</div>
</div>`
    : '';
  const nextCandidatesHtml = upcomingSorted.map((e, i) => `<div class="pr-square-latest-group next-event-candidate" data-date="${escapeHtml(e.date || '')}"${i === 0 ? '' : ' hidden'}>
  <div class="pr-square-label">Next Tournament</div>
  <div class="pr-square-latest-item">${escapeHtml(e.name || '')} &mdash; ${escapeHtml(formatDateHuman(e.date))}</div>
</div>`).join('\n');
  // allTournaments is sorted ascending by date (see main()), so the last
  // entries are the most recent; reverse so newest shows first.
  const recentTournamentsHtml = allTournaments.slice(-3).reverse()
    .map((t) => `<div class="pr-square-latest-item">${escapeHtml(t.label)} &mdash; ${formatDateHuman(t.date)}</div>`)
    .join('\n');
  const latestPluralHtml = `<div class="pr-square-latest-group" id="pr-square-latest-plural"${nextEvent ? ' hidden' : ''}>
  <div class="pr-square-label">Latest Tournaments</div>
${recentTournamentsHtml}
</div>`;
  const latestSectionHtml = `${latestSingleHtml}
<div id="pr-square-next-candidates">
${nextCandidatesHtml}
</div>
${latestPluralHtml}`;
  const prSquareHtml = `<div class="pr-square">
  <div class="pr-square-title"><img class="pr-square-logo" src="https://images.squarespace-cdn.com/content/v1/5a6facad12abd9a8e6582589/1533013208287-LWVLCI0D9HZTELC7P0KT/LogoTextOnly.png?format=1500w" alt="DeathBall"> Power Rankings &mdash; ${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}</div>
  <div class="pr-square-row">
    <div class="pr-square-col pr-square-col-card">
      <div class="pr-square-label">How to read player information</div>
      <div class="pr-card card-green pr-square-example">
        <div class="prc-top">
          <span class="prc-rank">1</span><span class="prc-name">Player Name</span>
        </div>
        <div class="prc-stats"><span class="prc-val">1850</span><span class="prc-dim">&#xB1;</span><span class="prc-val">45</span><span class="prc-sep">|</span><span class="prc-val">68</span><span class="prc-dim">W%</span><span class="prc-sep">|</span><span class="prc-val">32</span><span class="prc-dim">gp</span></div>
      </div>
      <div class="pr-square-callouts">
        <div class="pr-square-callout"><b>Rank</b> &middot; position in the ranking</div>
        <div class="pr-square-callout"><b>Rating</b> &middot; Glicko-2 skill estimate</div>
        <div class="pr-square-callout"><b>&#xB1;Deviation</b> &middot; confidence (lower is more certain)</div>
        <div class="pr-square-callout"><b>W% / gp</b> &middot; win rate and games played</div>
      </div>
    </div>
    <div class="pr-square-col pr-square-col-text">
      <div class="pr-square-label">How rankings are determined</div>
      <div class="pr-square-text">Every set updates both players' ratings with the Glicko-2 system, weighting opponent strength and match outcome. Ratings converge as players compete more, and a player's deviation (uncertainty) rises again the longer they go inactive.</div>
    </div>
    <div class="pr-square-qr-wrap">
      <div class="pr-square-qr"><img src="${assetDataUri('assets/qr-code.png')}" alt="QR code"></div>
      <div class="pr-square-qr-label">View Power Rankings</div>
    </div>
  </div>
  <div class="pr-square-row pr-square-row-2">
    <div class="pr-square-col pr-square-col-text">
      <div class="pr-square-stats">
        <div class="pr-square-stat"><span class="pr-square-stat-num">${playerRows.length}</span><span class="pr-square-stat-label">Players</span></div>
        <div class="pr-square-stat"><span class="pr-square-stat-num">${allTournaments.length}</span><span class="pr-square-stat-label">Tournaments</span></div>
        <div class="pr-square-stat"><span class="pr-square-stat-num">${totalMatches}</span><span class="pr-square-stat-label">Matches</span></div>
      </div>
      <div class="pr-square-latest">
${latestSectionHtml}
      </div>
    </div>
    <div class="pr-square-col pr-square-col-tagline">
      <div class="pr-square-tagline">Compete. Climb.<br>Get Ranked.</div>
    </div>
    <div class="pr-square-qr-wrap">
      <div class="pr-square-qr"><img src="${assetDataUri('assets/qr-code-discord.png')}" alt="Discord QR code"></div>
      <div class="pr-square-qr-label">Join the Discord</div>
    </div>
  </div>
  <div class="pr-square-footer">&copy; ${now.getFullYear()} LilyLambda – PR | Tony Hauber – DeathBall &middot; Data sourced from start.gg &amp; Challonge</div>
  <img class="pr-square-mascot" src="https://images.squarespace-cdn.com/content/v1/5a6facad12abd9a8e6582589/ab04b855-7d9a-4bb8-b6a9-9f456e9d395d/Purple-wizard-large-deathball-arcade.png" alt="">
</div>`;

  const mapPaths = mapRegions.map((r) => `<path class="map-region" data-id="${escapeHtml(r.id)}" data-players="${r.players}" data-tournaments="${r.tournaments}" d="${r.d}"><title>${escapeHtml(r.name)}: ${r.players} player${r.players === 1 ? '' : 's'}, ${r.tournaments} tournament${r.tournaments === 1 ? '' : 's'}</title></path>`).join('\n');
  const mapLabels = mapRegions.map((r) => `<text class="map-label" data-players="${r.players}" data-tournaments="${r.tournaments}" x="${r.cx}" y="${r.cy}"></text>`).join('\n');
  // Per-region player/tournament lists for the click-to-filter sidebar —
  // kept out of the SVG itself (which only needs counts to color/label
  // regions) and parsed once from this JSON blob by index.js. The special
  // "__ALL__" key holds the unfiltered lists shown by default (the sidebar
  // always shows a list; clicking a region filters it rather than
  // replacing it with a totally separate view).
  const toMapPlayerJson = (p) => ({ n: p.name, h: p.href, rank: p.rank, v: p.rating, rd: p.rd, la: p.lastActive, f: p.flag });
  const toMapTournamentJson = (t) => ({ n: t.label, h: t.href, d: t.date, di: t.dateIso, f: t.flag });
  const mapRegionData = Object.fromEntries(mapRegions.map((r) => [r.id, {
    name: r.name,
    playersList: r.playersList.map(toMapPlayerJson),
    tournamentsList: r.tournamentsList.map(toMapTournamentJson),
  }]));
  mapRegionData.__ALL__ = {
    name: 'All States',
    playersList: mapAllPlayers.map(toMapPlayerJson),
    tournamentsList: mapAllTournaments.map(toMapTournamentJson),
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeathBall Power Rankings</title>
<link rel="stylesheet" href="index.css">
<script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
</head>
<body>
<div class="page-title-row">
  <button class="tabs-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false" aria-controls="site-tabs"><svg class="tabs-toggle-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/></svg></button>
  <h1>DeathBall <span id="tab-heading">Power Rankings</span></h1>
  <button class="download-btn download-btn-icon" type="button" title="Download power rankings image" aria-label="Download power rankings image"><svg class="download-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8"/><path d="M4.5 7L8 10.5 11.5 7"/><path d="M2.5 12.5h11"/></svg><svg class="download-spinner" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M14 8a6 6 0 1 1-2-4.47"/></svg></button>
</div>
<div class="tabs" id="site-tabs">
  <button class="tab-button active" data-tab="rankings-tab">Power Rankings</button>
  <button class="tab-button" data-tab="players-tab">Players</button>
  <button class="tab-button" data-tab="tournaments-tab">Tournaments</button>
  <button class="tab-button" data-tab="doubles-tab">Doubles Teams</button>
  <button class="tab-button" data-tab="map-tab">Map</button>
  <button class="tab-button" data-tab="events-tab">Upcoming Events</button>
  <span class="tab-underline"></span>
</div>
<div class="tabs-backdrop"></div>

<div id="events-tab" class="tab-panel">
${buildEventsTabHtml(upcomingEvents)}
</div>

<div id="players-tab" class="tab-panel">
  <div class="tab-controls">
    <label>Location:
      <select class="state-filter-select">
        <option value="">All locations</option>
      </select>
    </label>
    <span class="filter-count">${playerRows.length} unique players. Click a column header to sort.</span>
  </div>
  <div class="table-wrap">
  <table data-sortable>
    <thead>
      <tr>
        <th data-type="string" class="sorted-asc">Player</th>
        <th data-type="string" data-blank-last="true" class="col-location">Location</th>
        <th data-type="number">Wins</th>
        <th data-type="number">Losses</th>
        <th data-type="number">Games</th>
        <th data-type="number">Win %</th>
        <th data-type="string">Last Active</th>
        <th data-type="number">Tournaments</th>
        <th data-type="string">Tournament List</th>
      </tr>
    </thead>
    <tbody>
${playerTableRows}
    </tbody>
  </table>
  </div>
</div>

<div id="tournaments-tab" class="tab-panel">
  <div id="count">${allTournaments.length} tournaments. Click a column header to sort.</div>
  <div class="table-wrap">
  <table data-sortable>
    <thead>
      <tr>
        <th data-type="string">Tournament</th>
        <th data-type="string" class="sorted-desc">Date</th>
        <th data-type="string">Location</th>
        <th data-type="string">Source</th>
        <th data-type="number">Participants</th>
        <th data-type="number">Matches</th>
      </tr>
    </thead>
    <tbody>
${tournamentTableRows}
    </tbody>
  </table>
  </div>
</div>

<div id="doubles-tab" class="tab-panel">
${buildDoublesTabHtml(doublesTeams)}
</div>

<div id="map-tab" class="tab-panel">
  <div class="tab-controls">
    <div class="view-toggle">
      <span class="view-toggle-indicator"></span>
      <button class="view-btn active" data-view="players">Players</button>
      <button class="view-btn" data-view="tournaments">Tournaments</button>
    </div>
    <div class="map-legend">
      <span class="map-legend-label">Fewer</span>
      <span class="map-legend-swatch"></span>
      <span class="map-legend-label">More</span>
    </div>
  </div>
  <div class="map-panel">
    <div class="map-canvas">
      <svg class="map-svg" viewBox="${MAP_HOME_VIEWBOX.join(' ')}" data-home="${MAP_HOME_VIEWBOX.join(' ')}" preserveAspectRatio="xMidYMid meet">
        <g class="map-regions">
${mapPaths}
        </g>
        <g class="map-labels">
${mapLabels}
        </g>
      </svg>
    </div>
    <div class="map-sidebar">
      <div class="map-sidebar-head">
        <h3 class="map-sidebar-title">All States</h3>
        <button class="map-sidebar-back" type="button" hidden>&times; Clear</button>
      </div>
      <div class="map-sidebar-colhead"></div>
      <ol class="standings-list map-sidebar-list"></ol>
    </div>
  </div>
</div>
<script type="application/json" id="map-region-data">${JSON.stringify(mapRegionData)}</script>

<div id="rankings-tab" class="tab-panel active show-rank-delta">
  <button class="rankings-options-toggle" type="button" aria-expanded="false" aria-controls="rankings-options-panel">Options <svg class="rankings-options-caret" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg></button>
  <div class="tab-controls" id="rankings-options-panel">
    <div class="view-toggle">
      <span class="view-toggle-indicator"></span>
      <button class="view-btn active" data-view="grid">Grid</button>
      <button class="view-btn" data-view="table">Table</button>
    </div>
    <div class="view-toggle rank-delta-toggle">
      <span class="view-toggle-indicator"></span>
      <button class="delta-btn" data-delta="hide">Hide &#916;</button>
      <button class="delta-btn active" data-delta="show">Show &#916;</button>
    </div>
    <label>Min games:
      <select class="min-games-select">
        <option value="1">All</option>
        <option value="5" selected>5+</option>
        <option value="10">10+</option>
        <option value="20">20+</option>
      </select>
    </label>
    <label>Max RD:
      <select class="max-rd-select">
        <option value="Infinity">All</option>
        <option value="250">250</option>
        <option value="200">200</option>
        <option value="150" selected>150</option>
        <option value="100">100</option>
        <option value="50">50</option>
      </select>
    </label>
    <label>Location:
      <select class="state-filter-select">
        <option value="">All locations</option>
      </select>
    </label>
    <label>Rankings at:
      <select class="pr-history-select"></select>
    </label>
    <button class="download-btn download-btn-boxed" type="button"><svg class="download-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8"/><path d="M4.5 7L8 10.5 11.5 7"/><path d="M2.5 12.5h11"/></svg><svg class="download-spinner" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M14 8a6 6 0 1 1-2-4.47"/></svg><span class="download-btn-label">Download PR</span></button>
  </div>
  <div class="pr-grid">
${prSquareHtml}
${rankingCardItems}
  </div>
  <div class="table-wrap">
  <table data-sortable style="display:none">
    <thead>
      <tr>
        <th data-type="number" class="sorted-asc rank-num">#</th>
        <th data-type="string">Player</th>
        <th data-type="number">Rating</th>
        <th data-type="number">RD</th>
        <th data-type="number">W</th>
        <th data-type="number">L</th>
        <th data-type="number">Games</th>
        <th data-type="number">Win %</th>
        <th data-type="string">Last Active</th>
        <th data-type="string" data-blank-last="true" class="col-location">Location</th>
      </tr>
    </thead>
    <tbody>
${rankingTableRows}
    </tbody>
  </table>
  </div>
</div>
<script type="application/json" id="pr-history-data">${JSON.stringify(rankingHistory)}</script>

${siteFooter('')}
<script src="index.js"></script>
</body>
</html>
`;

  fs.writeFileSync(path.join(REPO_ROOT, 'index.html'), html);
}

function matchScoreLabel(m) {
  if (m.isDQ) return 'DQ';
  if (m.games) {
    const w = m.games.filter((g) => g.winnerGoals > g.loserGoals).length;
    const l = m.games.length - w;
    return `${w}-${l}`;
  }
  if (m.winnerSets != null && m.loserSets != null) return `${m.winnerSets}-${m.loserSets}`;
  return '';
}

const BRACKETS_VIEWER_HEAD = `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/brackets-viewer@latest/dist/brackets-viewer.min.css">
<script src="https://cdn.jsdelivr.net/npm/brackets-viewer@latest/dist/brackets-viewer.min.js"></script>
<style>
  .brackets-viewer {
    /* Matches the page's own body background (#050505 in the main CSS)
       instead of the library's default off-black panel look, so the
       bracket reads as part of the page rather than a card sitting on it —
       same treatment the standings list already gets for free by not
       setting a background of its own. */
    --primary-background: #050505;
    --secondary-background: #111;
    --font-color: #f0f0f0;
    --border-color: #333;
    --border-hover-color: #3eff8b;
    --border-selected-color: #3eff8b;
    --connector-color: #444;
    --label-color: #888;
    --hint-color: #666;
    --win-color: #079b45;
    --loss-color: #af0505;
    /* The library pads itself 10px 50px by default (room for its own
       stage-name h1 and bracket titles); zeroed out so the bracket sits
       flush like every other section on the page instead of floating in
       its own inset box. */
    padding: 0;
  }
  /* The stage name the library prints as its own <h1> above the bracket
     duplicates the page's actual title (already shown once, larger, at the
     very top of the page) — hide the library's copy rather than carry a
     second heading with the same text. */
  .brackets-viewer h1 { display: none; }
  /* A bye never really happened as a match — remove the box from layout
     entirely. layoutBrackets() below re-lays the bracket out from actual
     feeder relationships, so no invisible placeholder is needed to keep
     sibling spacing intact (keeping one is what used to leave big empty
     gaps in bye-heavy brackets). */
  .brackets-viewer .match.bye-hidden { display: none; }
  /* The library draws connectors with border ::before/::after pseudo-
     elements whose elbow direction comes from :nth-of-type parity — wrong
     as soon as byes/irregular rounds break the textbook shape, and full of
     gaps at 3-way junctions. layoutBrackets() draws real SVG connectors
     instead, so the library's are disabled wholesale. */
  .brackets-viewer .match.connect-next::after,
  .brackets-viewer .opponents.connect-previous::before { content: none !important; }
  .brackets-viewer svg.bracket-connectors path {
    fill: none;
    stroke: var(--connector-color);
    stroke-width: 2px;
  }
  /* Ease the hover highlight in/out instead of snapping the instant the
     cursor crosses a box (the small delay also keeps a sweep of the mouse
     across the bracket from strobing every box it passes). The library
     applies hover as a full border shorthand with identical width/style,
     so transitioning just border-color covers it. */
  .brackets-viewer .opponents { transition: border-color 0.25s ease 0.08s; }
  /* The library's own .name>img rule force-crops images square (1em x 1em,
     object-fit cover) for avatars; flags are wider than tall, so let them
     keep their aspect ratio and match the standings list's styling. */
  .brackets-viewer .participant .name > img.loc-flag {
    width: auto;
    height: 1em;
    object-fit: contain;
    border-radius: 1px;
    margin-right: 5px;
  }
  /* A "pending"/not-yet-played match (status 0-3; 4 is completed, 5 is
     archived) — same warning color and background as the incomplete-bracket
     note above it. Overriding the library's own --border-color/
     --match-background variables (rather than drawing a border directly on
     .match) means the color reaches the .opponents/.participant boxes that
     actually paint it, replacing their default grey outline instead of
     layering a second box around it. (Positioning/sizing is fully handled
     by layoutBrackets() — an earlier align-self:flex-start hack here to
     stop a lone pending final stretching to fill its column also pinned it
     to the top, which then dragged the whole winners-bracket spine up with
     it.) */
  .brackets-viewer .match[data-match-status="0"],
  .brackets-viewer .match[data-match-status="1"],
  .brackets-viewer .match[data-match-status="2"],
  .brackets-viewer .match[data-match-status="3"] {
    --border-color: rgba(255,183,77,0.6);
    --match-background: rgba(255,183,77,0.08);
    /* Hover/selection stays in the pending palette — the green used for
       completed matches would read as a result where there isn't one. */
    --border-hover-color: rgba(255,183,77,0.95);
    --border-selected-color: rgba(255,183,77,0.95);
  }
  /* No score to show for a match that hasn't happened yet — blank the
     library's own "-" placeholder in favor of a single warning icon (added
     by markPendingMatches() below), sitting inside the card's own border
     rather than overlapping its edge. */
  .brackets-viewer .match[data-match-status="0"] .result,
  .brackets-viewer .match[data-match-status="1"] .result,
  .brackets-viewer .match[data-match-status="2"] .result,
  .brackets-viewer .match[data-match-status="3"] .result {
    visibility: hidden;
  }
  /* Increase font size of results */
  .brackets-viewer .participant .result {
    font-size: 13px;
    line-height: 12px;
    align-content: center;
  }
  /* .brackets-viewer .opponents>span / >span:nth-of-type(1) are the
     library's own rules for its seed-label spans (top:-10px, left:3px) —
     since our icon is also a bare <span> under .opponents (and the only
     one, making it nth-of-type(1) too), it inherits both. Both include a
     "span" type selector our class-only selector above lacked, which out-
     specifies it despite matching the same number of classes — hence
     !important here to guarantee our positioning wins regardless of the
     library's own selectors (which we don't control and could change). */
  .brackets-viewer .opponents .match-pending-icon {
    position: absolute;
    top: 3px !important;
    left: auto !important;
    right: 1px !important;
    font-size: 1.1em;
    line-height: 1;
    color: #ffb74d;
    background-color: transparent;
  }
  /* Synced with the standings list (see .standings-list li.player-active
     and setupBracketInteractivity below): hovering or clicking a player
     anywhere highlights every match they appear in across the whole
     bracket (background only), plus their standings row. The green border
     outline stays native-hover-only (--border-hover-color above), so it
     marks just the exact match under the cursor rather than spreading to
     every match the highlighted player appears in. */
  .brackets-viewer .participant { cursor: pointer; }
  .brackets-viewer .participant.player-active { background-color: rgba(62,255,139,0.18); }
  /* Click-and-drag panning, and the arrow-key scroll from keydown below —
     both need the container to actually be scrollable (it already is,
     horizontally, via the library's own overflow:auto) and focusable
     (tabindex is set in JS since it's an attribute, not a style). */
  .brackets-viewer { cursor: grab; }
  .brackets-viewer.dragging { cursor: grabbing; }
  .brackets-viewer:focus { outline: none; }
</style>
<script>
  // brackets-viewer positions matches with equal-height flex columns
  // (every match flex:1, byes included) and draws connectors from round
  // parity — both assume a textbook bracket where each round has exactly
  // half the previous round's matches. Real brackets here (bye-padded,
  // sometimes abandoned mid-event) don't obey that, and an earlier
  // approach of patching the library's guesses match-by-match (hiding bye
  // boxes but keeping their space, translateY-shifting lone feeders toward
  // whatever position their target happened to land on) compounded errors
  // instead of fixing them. So after render we discard the library's
  // positioning and connectors entirely and re-derive the layout from the
  // actual feeder relationships in the DOM:
  //   - bye matches are dropped from layout completely (no empty slots);
  //   - a match nothing real feeds into takes the next compact vertical
  //     slot; a match with one real feeder sits level with it (straight
  //     connector); one with two sits at their midpoint — so finals land
  //     mid-bracket instead of wherever flex put them;
  //   - connectors are drawn as SVG paths between the real boxes, giving
  //     gap-free 3-point junctions.
  // Safe to re-run (fonts.ready below re-invokes it once metrics settle).
  function layoutBrackets() {
    for (const rounds of document.querySelectorAll('.brackets-viewer .bracket .rounds')) layoutRounds(rounds);
  }

  function layoutRounds(container) {
    const rounds = [...container.querySelectorAll(':scope > .round')];
    if (!rounds.length) return;

    // Per-round lookup of who won what. Byes are hidden and never laid
    // out, but a player can sit out a round (bye) between two real
    // matches, so feeder lookups scan back past the immediately-previous
    // round until they find the player's last real win.
    const roundInfos = rounds.map((round) => {
      const real = [];
      const winners = new Map();
      for (const el of round.querySelectorAll(':scope > .match')) {
        if (el.querySelector('.name.bye')) { el.classList.add('bye-hidden'); continue; }
        const m = { el, y: null, children: [] };
        real.push(m);
        const win = el.querySelector('.participant.win');
        if (win && win.dataset.participantId) winners.set(win.dataset.participantId, m);
      }
      return { round, real, winners };
    });

    // Link each match to the matches that feed it: for each opponent,
    // their nearest earlier real win in this bracket section. No hit means
    // they arrived from outside the section (a winners-bracket dropper
    // entering the losers bracket) — no connector. Earlier rounds claim
    // first (ascending order), so e.g. a grand final claims the WB final
    // before a bracket-reset match can reach past it; the claimed set
    // guarantees each match feeds at most one later match.
    const claimed = new Set();
    for (let i = 1; i < roundInfos.length; i++) {
      for (const m of roundInfos[i].real) {
        for (const p of m.el.querySelectorAll(':scope > .opponents > .participant')) {
          const id = p.dataset.participantId;
          if (!id) continue; // TBD slot of a pending match
          for (let j = i - 1; j >= 0; j--) {
            const feeder = roundInfos[j].winners.get(id);
            if (feeder) {
              if (!claimed.has(feeder)) { m.children.push(feeder); claimed.add(feeder); }
              break;
            }
          }
        }
      }
    }

    // Assign vertical slots: DFS from each root (any match nothing later
    // claimed), leaves take successive compact slots, parents center on
    // their children. Later-round roots go first so the main bracket tree
    // lays out top-anchored and any stray unfinished subtrees stack below.
    let nextLeaf = 0;
    const assign = (m) => {
      if (m.y != null) return m.y;
      if (!m.children.length) return (m.y = nextLeaf++);
      return (m.y = m.children.map(assign).reduce((a, b) => a + b, 0) / m.children.length);
    };
    for (let i = roundInfos.length - 1; i >= 0; i--) {
      for (const m of roundInfos[i].real) if (!claimed.has(m)) assign(m);
    }

    const allReal = roundInfos.flatMap((info) => info.real);
    if (!allReal.length) return;
    const boxH = allReal[0].el.querySelector(':scope > .opponents').getBoundingClientRect().height;
    const gap = 20; // matches the library's own 10px top+bottom match margin
    const pitch = boxH + gap;

    for (const { round, real } of roundInfos) {
      const h3 = round.querySelector(':scope > h3');
      const base = (h3 ? h3.offsetHeight : 0) + gap;
      round.style.position = 'relative';
      round.style.height = (base + nextLeaf * pitch - gap) + 'px';
      for (const m of real) {
        m.el.style.position = 'absolute';
        m.el.style.margin = '0';
        m.el.style.transform = 'none';
        m.el.style.height = boxH + 'px';
        m.el.style.top = (base + m.y * pitch) + 'px';
      }
    }

    // Connectors, drawn from the now-final geometry. A feeder level with
    // its target gets a plain straight line; otherwise elbow horizontally
    // to just before the target column, then vertically to its center —
    // two feeders of one match share that junction point, forming a clean
    // T with no gaps.
    const old = container.querySelector(':scope > svg.bracket-connectors');
    if (old) old.remove();
    const cRect = container.getBoundingClientRect();
    let paths = '';
    for (const m of allReal) {
      if (!m.children.length) continue;
      const t = m.el.getBoundingClientRect();
      const tx = t.left - cRect.left;
      const ty = t.top + t.height / 2 - cRect.top;
      for (const c of m.children) {
        const f = c.el.getBoundingClientRect();
        const fx = f.right - cRect.left;
        const fy = f.top + f.height / 2 - cRect.top;
        paths += Math.abs(fy - ty) < 1
          ? '<path d="M ' + fx + ' ' + fy + ' H ' + tx + '" />'
          : '<path d="M ' + fx + ' ' + fy + ' H ' + (tx - 20) + ' V ' + ty + ' H ' + tx + '" />';
      }
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'bracket-connectors');
    svg.setAttribute('width', container.scrollWidth);
    svg.setAttribute('height', container.scrollHeight);
    svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
    svg.innerHTML = paths;
    container.style.position = 'relative';
    container.insertBefore(svg, container.firstChild);
  }

  // The library's built-in group titles are singular ("Winner Bracket",
  // "Loser Bracket") with no locale/config hook to change them — swap in
  // the plural form we actually want by exact text match.
  function pluralizeBracketNames() {
    for (const h2 of document.querySelectorAll('.brackets-viewer .bracket h2')) {
      if (h2.textContent === 'Winner Bracket') h2.textContent = 'Winners Bracket';
      else if (h2.textContent === 'Loser Bracket') h2.textContent = 'Losers Bracket';
    }
  }

  // Box heights can shift once webfonts finish loading; re-run the layout
  // with settled metrics (layoutRounds fully re-derives, so this is safe).
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => layoutBrackets());

  // Prepends each participant's location flag (same imagery as the
  // standings list) to their name in every bracket box. Flags are keyed by
  // participant id rather than name so split identities sharing a display
  // name stay distinct. Safe to call once per stage: already-flagged rows
  // are skipped.
  function addBracketFlags(selector, flags) {
    for (const p of document.querySelectorAll(selector + ' .participant[data-participant-id]')) {
      const f = flags[p.dataset.participantId];
      if (!f) continue;
      const nameEl = p.querySelector('.name');
      if (!nameEl || nameEl.querySelector('img.loc-flag')) continue;
      const img = document.createElement('img');
      img.className = 'loc-flag';
      img.src = f.src;
      img.title = f.title;
      img.alt = f.title;
      nameEl.insertBefore(img, nameEl.firstChild);
    }
  }

  // Marks every not-yet-played match (status 0-3) with the same warning
  // icon used in the incomplete-bracket note above, instead of the "-" the
  // library prints per opponent when there's no score yet (that CSS-hides
  // the "-" — see .result above — this just adds the one icon per card).
  function markPendingMatches() {
    for (const m of document.querySelectorAll('.brackets-viewer .match[data-match-status]')) {
      if (m.dataset.matchStatus === '4' || m.dataset.matchStatus === '5') continue;
      const opponents = m.querySelector('.opponents');
      if (!opponents || opponents.querySelector('.match-pending-icon')) continue;
      const icon = document.createElement('span');
      icon.className = 'match-pending-icon';
      // U+FE0E forces the monochrome text glyph. Without it this renders as
      // a color emoji here (unlike the identical ⚠ in the plain-text note
      // above) because .brackets-viewer's own font-family list includes
      // color-emoji fonts ("Segoe UI Emoji" etc.) as fallbacks, which
      // Chromium's shaper can pick for a lone symbol character even though
      // ⚠ defaults to text presentation.
      icon.textContent = '⚠︎ ';
      opponents.appendChild(icon);
    }
  }

  // Highlights one player everywhere they appear on the page — every
  // bracket match they're in (across every stage/container, in case a
  // tournament has more than one) and their standings row — or clears the
  // highlight when called with null. Matched by canonical display name
  // (the same string both the standings list and every bracket participant
  // were rendered with), since bracket participant ids are only unique
  // within their own stage's render, not across the whole page.
  function setActivePlayer(name) {
    for (const el of document.querySelectorAll('.player-active')) el.classList.remove('player-active');
    if (!name) return;
    const li = document.querySelector('.standings-list li[data-player="' + CSS.escape(name) + '"]');
    if (li) li.classList.add('player-active');
    for (const p of document.querySelectorAll('.brackets-viewer .participant[data-participant-id]')) {
      const nameEl = p.querySelector('.name');
      if (!nameEl || nameEl.textContent.trim() !== name) continue;
      p.classList.add('player-active');
    }
  }

  // Wires up: (1) hover/click sync between the standings list and every
  // bracket on the page via setActivePlayer, with click "pinning" the
  // highlight so it survives the mouse moving away — otherwise there'd be
  // no way to highlight a run and then actually look at it; (2) click-and-
  // drag panning and left/right-arrow scrolling for each bracket container,
  // since a wide bracket only exposes a horizontal scrollbar that's easy to
  // miss. Called once per page, after every stage has rendered.
  function setupBracketInteractivity() {
    let pinned = null;
    let dragMoved = false; // suppresses the click a drag-release generates

    function playerNameAt(el) {
      const li = el.closest('.standings-list li[data-player]');
      if (li) return li.dataset.player;
      const p = el.closest('.brackets-viewer .participant[data-participant-id]');
      if (!p) return null;
      const nameEl = p.querySelector('.name');
      return nameEl ? nameEl.textContent.trim() : null;
    }

    document.addEventListener('mouseover', (e) => {
      if (pinned) return;
      const name = playerNameAt(e.target);
      if (name) setActivePlayer(name);
    });
    document.addEventListener('mouseout', (e) => {
      if (pinned) return;
      if (!playerNameAt(e.target)) return;
      // Moving between child elements of the same row shouldn't flicker
      // the highlight off and back on.
      if (e.relatedTarget && e.target.contains(e.relatedTarget)) return;
      setActivePlayer(null);
    });
    document.addEventListener('click', (e) => {
      if (dragMoved) { dragMoved = false; return; }
      const name = playerNameAt(e.target);
      if (!name) {
        if (pinned) { pinned = null; setActivePlayer(null); }
        return;
      }
      if (pinned === name) { pinned = null; setActivePlayer(null); }
      else { pinned = name; setActivePlayer(name); }
    });

    for (const bv of document.querySelectorAll('.brackets-viewer')) {
      bv.setAttribute('tabindex', '0');
      let dragging = false;
      let startX = 0;
      let startScroll = 0;
      bv.addEventListener('mousedown', (e) => {
        dragging = true;
        dragMoved = false;
        startX = e.clientX;
        startScroll = bv.scrollLeft;
        bv.classList.add('dragging');
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 4) dragMoved = true;
        bv.scrollLeft = startScroll - dx;
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        bv.classList.remove('dragging');
      });
      bv.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') { bv.scrollLeft -= 200; e.preventDefault(); }
        else if (e.key === 'ArrowRight') { bv.scrollLeft += 200; e.preventDefault(); }
      });
    }
  }
</script>`;

// Renders a raw in-tournament name as canonical-name-plus-flag markup.
function nameHtml(rawName, tournamentUrl) {
  if (!rawName) return escapeHtml('?');
  const { id, name, flag } = resolveDisplayName(rawName, tournamentUrl);
  const flagImg = flag ? `<img class="loc-flag" src="${escapeHtml(flag.src)}" title="${escapeHtml(flag.title)}" alt="${escapeHtml(flag.title)}">` : '';
  const href = playerHref(id, '../');
  const inner = `${flagImg}${escapeHtml(name)}`;
  return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
}

// Doubles-aware counterpart to nameHtml, for tournament pages -- splits the
// raw team name into its two component players and links each individually
// (clicking either name goes to that player's own page), always joined by
// "&" regardless of what separator the source bracket actually used. Falls
// back to nameHtml itself if the raw string can't be split (e.g. a name
// with no + or & wasn't a proper doubles entry).
function teamNameHtml(rawTeamName, tournamentUrl) {
  const parts = parseTeamName(rawTeamName);
  if (!parts) return nameHtml(rawTeamName, tournamentUrl);
  const spans = parts.map((raw) => {
    const { id, name, flag } = resolveDisplayName(raw, tournamentUrl);
    const flagImg = flag ? `<img class="loc-flag" src="${escapeHtml(flag.src)}" title="${escapeHtml(flag.title)}" alt="${escapeHtml(flag.title)}">` : '';
    const href = playerHref(id, '../');
    const inner = `${flagImg}${escapeHtml(name)}`;
    return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
  });
  return spans.join(' <span class="doubles-amp">&amp;</span> ');
}

// Standings/crosstable already canonicalize names (aliases/splits resolved)
// before this point, so by the time we'd call nameHtml the original raw
// in-tournament spelling is gone — re-resolving the *canonical* name against
// this tournament's URL is unreliable whenever it happens to case-
// insensitively collide with an unrelated split entry keyed for other
// tournaments (observed: "Kevan S" colliding with the "Kevan s" split, which
// only resolves for two other tournaments, silently losing the flag that the
// correct raw name "Kevan" would have resolved). Map back to a raw name that
// actually canonicalizes to the given name in this tournament before
// resolving, so flag lookup runs against the same raw name the bracket
// viewer already resolves successfully.
const canonicalToRawCache = new WeakMap();
function rawNameForCanonical(t, canonicalName) {
  let map = canonicalToRawCache.get(t);
  if (!map) {
    map = new Map();
    const consider = (raw) => {
      if (!raw || map.has(resolveIdentity(raw, t.url).name)) return;
      map.set(resolveIdentity(raw, t.url).name, raw);
    };
    for (const p of t.participantList) consider(p.name);
    for (const m of t.matches) { consider(m.winnerName); consider(m.loserName); }
    canonicalToRawCache.set(t, map);
  }
  return map.get(canonicalName) || canonicalName;
}

// Deletes any *.html file in `dir` not in `keepFilenames` — e.g. a
// tournament whose slug changed, or a player merged/hidden away since the
// last run — so stale pages don't linger in the output forever.
function cleanStaleHtml(dir, keepFilenames) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.html') && !keepFilenames.has(f)) fs.unlinkSync(path.join(dir, f));
  }
}

function writeTournamentPages(allTournaments) {
  const dir = path.join(REPO_ROOT, 'tournaments');
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set();

  for (const t of allTournaments) {
    const standings = buildStandings(t);
    // Doubles tournaments render each roster/match slot as two individually
    // clickable player links (teamNameHtml) instead of one opaque team-name
    // link (nameHtml) -- see requirement in teamNameHtml's own comment.
    const teamAware = (raw) => (t.isDoubles ? teamNameHtml(raw, t.url) : nameHtml(raw, t.url));

    const standingsHtml = standings.length
      ? `<ol class="standings-list">
${standings.map((s) => `      <li data-player="${escapeHtml(s.name)}"><span class="standings-rank">${s.rank != null ? s.rank : '—'}</span><span>${teamAware(rawNameForCanonical(t, s.name))}</span><span class="standings-record">${s.wins}-${s.losses}</span></li>`).join('\n')}
    </ol>`
      : '<p>No standings available.</p>';

    let extraHead = '';
    const stageSections = t.stages.map((stage) => {
      const heading = stage.label ? `<h3 class="stage-label">${escapeHtml(stage.label)}</h3>\n` : '';
      const st = stage.tLike;

      if (stage.bracketData) {
        extraHead = BRACKETS_VIEWER_HEAD;
        const containerId = `bv-${stage.label ? slugify(stage.label) : 'main'}`;
        const { incomplete, participants, ...rest } = stage.bracketData;
        const renderData = { ...rest, participants: participants.map(({ flag, ...p }) => p) };
        const flagById = {};
        for (const p of participants) if (p.flag) flagById[p.id] = { src: p.flag.src, title: p.flag.title };
        const note = incomplete ? '<p class="bracket-incomplete-note">&#9888; This bracket was not finished — some matches are missing from the source data, so results past that point aren\'t shown.</p>' : '';
        return `${heading}${note}<div class="brackets-viewer" id="${containerId}"></div>
<script>
  window.bracketsViewer.render(${JSON.stringify(renderData)}, { selector: '#${containerId}' });
  addBracketFlags('#${containerId}', ${JSON.stringify(flagById)});
  pluralizeBracketNames();
  layoutBrackets();
  markPendingMatches();
</script>`;
      }

      if (st.tournamentType === 'round robin' || st.tournamentType === 'swiss') {
        const stageStandings = stage.label ? buildStandings(st) : standings;
        const { names, cell } = buildCrosstable(st, stageStandings);
        return `${heading}<div class="crosstable-wrap">
  <table class="crosstable">
    <thead><tr><th></th>${names.map((n) => `<th>${teamAware(rawNameForCanonical(t, n))}</th>`).join('')}</tr></thead>
    <tbody>
${names.map((rowName) => `      <tr><th class="row-name">${teamAware(rawNameForCanonical(t, rowName))}</th>${names.map((colName) => {
          const c = cell(rowName, colName);
          if (c === null) return '<td class="cell-diag">&mdash;</td>';
          if (c.empty) return '<td class="cell-empty">&middot;</td>';
          const cls = c.label === 'W' ? 'cell-win' : c.label === 'L' ? 'cell-loss' : 'cell-draw';
          return `<td class="${cls}" title="${escapeHtml(c.title)}">${c.label}</td>`;
        }).join('')}</tr>`).join('\n')}
    </tbody>
  </table>
</div>`;
      }

      const roundGroups = buildRoundGroups(st);
      return `${heading}${roundGroups.map((g) => `<div class="round-group">
      <h3>${escapeHtml(g.label)}</h3>
${g.matches.map((m) => `      <div class="match-row"><span class="match-winner">${teamAware(m.winnerName)}</span><span> def. </span><span class="match-loser">${teamAware(m.loserName)}</span>${m.isDQ ? '<span class="match-dq">(DQ)</span>' : ''}<span class="match-score">${escapeHtml(matchScoreLabel(m))}</span></div>`).join('\n')}
    </div>`).join('\n')}`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t.label)} — DeathBall Power Rankings</title>
<link rel="stylesheet" href="../index.css">
${extraHead}
</head>
<body>
<h1>${escapeHtml(t.label)}${t.isDoubles ? ' <span class="doubles-pill">Doubles</span>' : ''}</h1>
<div class="tourney-meta">
  <span class="tourney-date">${escapeHtml(formatDateHuman(t.date))}</span>
  ${t.locationDisplay.venue || t.locationDisplay.cityState ? `<span class="tourney-loc">${locationHtml(t.locationDisplay)}</span>` : ''}
  <a class="tourney-original-link" href="${escapeHtml(t.url)}" target="_blank" rel="noopener">View original on ${escapeHtml(t.source)} &#8599;</a>
</div>
<a class="back-link" href="../index.html">&larr; Back to rankings</a>

<div class="tourney-columns">
  <div class="tourney-section tourney-standings">
    <h2>Standings</h2>
    ${standingsHtml}
  </div>

  <div class="tourney-section tourney-matches">
    <h2>Matches</h2>
    ${stageSections}
    ${extraHead ? '<script>setupBracketInteractivity();</script>' : ''}
  </div>
</div>
${siteFooter('../')}
</body>
</html>
`;

    keep.add(`${t.slug}.html`);
    fs.writeFileSync(path.join(dir, `${t.slug}.html`), html);
  }

  cleanStaleHtml(dir, keep);
}

function ordinal(n) {
  if (n == null) return '—';
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function opponentLinkHtml(id, name) {
  const href = playerHref(id, '../');
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(name)}</a>` : escapeHtml(name);
}

const PAGE_SIZE = 10;

// Renders a <ol> where only the first PAGE_SIZE <li>s start visible (the
// rest carry `hidden` — server-rendered so there's no flash of the full list
// before JS runs), plus a "Show more" button that reveals PAGE_SIZE more per
// click. wireShowMore() in each player page's inline script drives it.
function paginatedListHtml(items, listId, renderItem, emptyMessage) {
  if (!items.length) return `<p>${emptyMessage}</p>`;
  const lis = items.map((item, i) => renderItem(item, i >= PAGE_SIZE)).join('\n');
  const btn = items.length > PAGE_SIZE ? `<button type="button" class="show-more-btn" id="${listId}-more" data-list="${listId}">Show more</button>` : '';
  return `<ol class="standings-list" id="${listId}">
${lis}
    </ol>
    ${btn}`;
}

// One HTML page per known player under players/, linked from tournament
// standings/crosstables/round-lists (nameHtml) and the Players/Rankings tabs
// (writeHtml) — but deliberately not from the brackets-viewer bracket itself,
// which renders participant names as opaque JSON text with no HTML hook.
// Renders the "Historical Rating" line chart for a player page: one point per
// tournament they actually competed in (chronological), y-axis is Glicko-2
// conservative rating. Rank-at-the-time and the tournament name/date ride
// along as data attributes for the hover tooltip rather than a second axis —
// a player's rank moves for reasons that have nothing to do with their own
// rating (opponents joining/leaving the field), so charting it as a second
// line would invite a two-axis reading of one trend. history must have 2+
// points; the caller is responsible for the "not enough history yet" case.
function buildRatingChartSvg(history) {
  const W = 720;
  const H = 220;
  // Padding just enough that the first/last point's dot + its outline stroke
  // (r=3.5, stroke-width 1.5 — see .chart-dot) aren't flush against the SVG's
  // own edge — the plot otherwise runs edge-to-edge, since axis/date labels
  // now live outside the SVG as HTML overlays (see preserveAspectRatio="none"
  // below and the .chart-label rules). 6 previously left the endpoint dots
  // reading as clipped once the chart was squeezed into a narrow mobile
  // column, where the rendered margin (padL/W of the actual pixel width)
  // shrinks below the dot's own visual radius.
  const padL = 14;
  const padR = 14;
  const padT = 24; // extra headroom so the floating current-rating label (anchored above the last point) never crowds the top edge
  const padB = 10;
  const n = history.length;
  const ratings = history.map((h) => h.rating);
  let minR = Math.min(...ratings);
  let maxR = Math.max(...ratings);
  if (minR === maxR) { minR -= 50; maxR += 50; }
  const span = maxR - minR;
  minR -= span * 0.1;
  maxR += span * 0.1;

  const x = (i) => padL + (n === 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const y = (r) => padT + (1 - (r - minR) / (maxR - minR)) * (H - padT - padB);

  const gridTicks = [0, 0.5, 1].map((t) => {
    const gy = padT + t * (H - padT - padB);
    const val = Math.round(maxR - t * (maxR - minR));
    return { gy, val };
  });
  const gridLines = gridTicks.map(({ gy }) => `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" class="chart-grid"/>`).join('\n');
  const yLabels = gridTicks.map(({ gy, val }) => `<div class="chart-label chart-label-y" style="top:${((gy / H) * 100).toFixed(2)}%">${val}</div>`).join('\n');

  const points = history.map((h, i) => [x(i), y(h.rating)]);
  const polyline = `<polyline points="${points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ')}" class="chart-line"/>`;

  const markers = history.map((h, i) => {
    const [px, py] = points[i];
    const label = `${h.label}, ${formatDateHuman(h.date)} — Rating ${h.rating}, Rank #${h.rank || '?'}`;
    return `<a href="../tournaments/${escapeHtml(h.slug)}.html" class="chart-point" tabindex="0" aria-label="${escapeHtml(label)}" data-date="${escapeHtml(formatDateHuman(h.date))}" data-label="${escapeHtml(h.label)}" data-rating="${h.rating}" data-rank="${h.rank || ''}">
  <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="10" class="chart-hit"/>
  <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.5" class="chart-dot"/>
</a>`;
  }).join('\n');

  const first = history[0];
  const last = history[n - 1];
  const dateLabels = `<div class="chart-label chart-label-date-start">${escapeHtml(formatMonthYearHumanFull(first.date))}</div>
<div class="chart-label chart-label-date-end">${escapeHtml(formatMonthYearHumanFull(last.date))}</div>`;

  const lastPoint = points[n - 1];
  const currentLabel = `<div class="chart-label chart-label-current" style="right:${(((W - lastPoint[0]) / W) * 100).toFixed(2)}%; top:${((lastPoint[1] / H) * 100).toFixed(2)}%">${last.rating}</div>`;

  return `<div class="rating-chart-wrap">
  <div class="rating-chart-inner">
    <svg viewBox="0 0 ${W} ${H}" class="rating-chart" preserveAspectRatio="none">
      ${gridLines}
      ${polyline}
      ${markers}
    </svg>
    ${yLabels}
    ${dateLabels}
    ${currentLabel}
    <div class="chart-tooltip" hidden></div>
  </div>
</div>`;
}

function writePlayerPages(players, glicko, histories, rankingRows, ratingHistoryById, doublesHistories) {
  const dir = path.join(REPO_ROOT, 'players');
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set();

  const officialRows = rankingRows.filter((r) => r.games >= 5 && r.rd <= 150);

  for (const [id, p] of players.entries()) {
    const slug = playerSlugById.get(id);
    if (!slug) continue;
    const name = displayName(p);
    const info = lookupPlayerInfo(id, name);
    const flag = flagForInfo(info);
    const location = info.city ? [info.city, info.state].filter(Boolean).join(', ')
      : info.state ? (STATE_NAMES[info.state] || info.state) : (info.country || '');

    const aliases = aliasesUsed(p);

    // A player only ever gets `players` entries via recordMatch (singles) or
    // registerDoublesParticipants (doubles) -- 0 games means they've never
    // played a real singles match, i.e. every tournament on file for them is
    // doubles. Their page shows only the Tournaments list and Doubles
    // section (see the branch near the bottom of this loop); top stat
    // tiles/chart/Match Statistics/match log would all just be empty/zero.
    const isDoublesOnly = p.games === 0;

    const hist = histories.get(id) || { matches: [], placements: [] };
    let stocksFor = 0;
    let stocksAgainst = 0;
    for (const m of hist.matches) {
      if (m.isDQ) continue;
      stocksFor += m.stocksFor;
      stocksAgainst += m.stocksAgainst;
    }

    const placementsDesc = [...hist.placements].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const matchesDesc = [...hist.matches].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.order - a.order));

    const h2h = buildHeadToHead(hist.matches);
    const ratingHistory = ratingHistoryById.get(id) || [];

    const rankIdx = rankingRows.findIndex((r) => r.id === id);
    const rankingRow = rankIdx >= 0 ? rankingRows[rankIdx] : null;
    const officialIdx = officialRows.findIndex((r) => r.id === id);

    // Signature win: the highest-rated opponent (rating as they entered that
    // tournament, not their current rating) this player has beaten. Also
    // surfaces the opponent's current overall rank and how many spots that
    // is above/below this player's own rank, for context on how big a scalp
    // it still is today.
    const bestWinMatch = hist.matches
      .filter((m) => m.won && !m.isDQ && m.opponentRatingAtMatch != null)
      .reduce((best, m) => (!best || m.opponentRatingAtMatch > best.opponentRatingAtMatch ? m : best), null);
    let bestWin = null;
    if (bestWinMatch) {
      const oppRankIdx = rankingRows.findIndex((r) => r.id === bestWinMatch.opponentId);
      bestWin = {
        opponentId: bestWinMatch.opponentId,
        opponentName: bestWinMatch.opponentName,
        rating: bestWinMatch.opponentRatingAtMatch,
        oppRank: oppRankIdx >= 0 ? oppRankIdx + 1 : null,
        spots: (oppRankIdx >= 0 && rankIdx >= 0) ? (rankIdx - oppRankIdx) : null,
      };
    }

    const winPct = p.games > 0 ? p.wins / p.games : 0;
    const stockDiff = stocksFor - stocksAgainst;

    const flagImg = flag ? `<img class="loc-flag" src="${escapeHtml(flag.src)}" title="${escapeHtml(flag.title)}" alt="${escapeHtml(flag.title)}">` : '';

    // Years the player has tournament placements in, collapsed to a single
    // year ("2021") or a range ("2021-2024") for a compact tenure callout
    // shown in the subtitle rather than a stat tile.
    const activeYears = [...new Set(hist.placements.map((pl) => (pl.date || '').slice(0, 4)).filter(Boolean))].sort();
    const activeRange = activeYears.length
      ? (activeYears[0] === activeYears[activeYears.length - 1] ? activeYears[0] : `${activeYears[0]}-${activeYears[activeYears.length - 1]}`)
      : '';

    const statTiles = `<div class="stat-tile stat-span-3">
  <div class="stat-multi">
    <span><span class="stat-value">${p.wins}-${p.losses} (${(winPct * 100).toFixed(1)}%)</span><span class="stat-label">Record</span></span>
    <span><span class="stat-value">${p.games}</span><span class="stat-label">Games Played</span></span>
  </div>
</div>`;

    const goalsTile = `<div class="stat-tile stat-span-4">
  <div class="stat-multi">
    <span><span class="stat-value">${stocksFor}</span><span class="stat-label">Goals Scored</span></span>
    <span><span class="stat-value">${stocksAgainst}</span><span class="stat-label">Goals Allowed</span></span>
    <span><span class="stat-value">${stockDiff > 0 ? '+' : ''}${stockDiff}</span><span class="stat-label">Goal Diff.</span></span>
  </div>
</div>`;

    // One combined card (Power Ranking, Overall Ranking, Glicko-2 Rating, RD)
    // instead of two separate tiles — same underlying rankingRow/officialIdx
    // data as before, just laid out left-to-right as one stat-multi row.
    // When not qualified, name the specific blocker(s) instead of a blanket
    // "needs 5+ games, RD <= 150" — a player short on RD only shouldn't be
    // told they also need more games when they don't.
    const qualBlockers = [];
    if (officialIdx < 0) {
      if (p.games < 5) qualBlockers.push('5+ games');
      if ((rankingRow ? rankingRow.rd : GLICKO_DEFAULT_RD) > 150) qualBlockers.push('RD ≤ 150');
    }
    const qualNote = qualBlockers.length ? `Needs ${qualBlockers.join(', ')}` : '';

    // The note is absolutely positioned (see .stat-note) so it never adds a
    // line to the stat-multi row or changes the tile's height — a
    // Not-Qualified card renders pixel-identical to a qualified one, just
    // with a note overlaid near the bottom.
    const rankingTiles = `<div class="stat-tile stat-span-6">
  <div class="stat-multi">
    <span><span class="stat-value">${officialIdx >= 0 ? `#${officialIdx + 1}` : 'Not Qualified'}</span><span class="stat-label">Power Ranking</span></span>
    <span><span class="stat-value">${rankingRow ? `#${rankIdx + 1}` : 'Unranked'}</span><span class="stat-label">Overall Ranking</span></span>
    <span><span class="stat-value">${rankingRow ? Math.round(rankingRow.r) : '—'}</span><span class="stat-label">Glicko-2 Rating</span></span>
    <span><span class="stat-value">${rankingRow ? `±${Math.round(rankingRow.rd)}` : '—'}</span><span class="stat-label">RD</span></span>
  </div>
  ${qualNote ? `<div class="stat-note">${escapeHtml(qualNote)}</div>` : ''}
</div>`;

    const recentMatchesHtml = paginatedListHtml(matchesDesc, 'recent-matches-list', (m, hidden) =>
      `      <li${hidden ? ' hidden' : ''}><span class="standings-rank ${m.won ? 'result-win' : 'result-loss'}"><span class="result-letter">${m.won ? 'W' : 'L'}</span> <span class="match-score-mini">${m.isDQ ? 'DQ' : `${m.scoreFor}-${m.scoreAgainst}`}</span></span><span>vs ${opponentLinkHtml(m.opponentId, m.opponentName)} <span class="match-tourney-name">(<a href="../tournaments/${escapeHtml(m.tournamentSlug)}.html">${escapeHtml(m.tournamentLabel)}</a>)</span></span><span class="standings-record">${dateDualHtml(m.date)}</span></li>`,
      'No matches on record.');

    // A handful of Match Statistics labels are shorter on mobile than
    // desktop (e.g. "Best Win Rate (Min. 3)" vs "Best Win Rate") -- both
    // variants are always rendered, with CSS (.stat-label-full/-short)
    // picking one per viewport, rather than actually changing the label per
    // breakpoint. mobileLabel defaults to the desktop label when the two
    // don't differ, which just renders the plain text with no dual spans.
    const dualLabelHtml = (label, mobileLabel) => (!mobileLabel || mobileLabel === label)
      ? escapeHtml(label)
      : `<span class="stat-label-full">${escapeHtml(label)}</span><span class="stat-label-short">${escapeHtml(mobileLabel)}</span>`;
    const h2hRow = (label, entry, formatMetric, iconKey, flip, mobileLabel) => {
      const icon = h2hIcon(iconKey, flip);
      const labelHtml = dualLabelHtml(label, mobileLabel);
      if (!entry) return `<div class="h2h-tile"><span class="h2h-label">${icon}${labelHtml}</span><span class="h2h-value">&mdash;</span></div>`;
      return `<div class="h2h-tile"><span class="h2h-label">${icon}${labelHtml}</span><span class="h2h-value">${opponentLinkHtml(entry.opponentId, entry.opponentName)} <span class="h2h-count">${formatMetric(entry)}</span></span></div>`;
    };
    const bestWinMetric = (e) => {
      const rankLabel = e.oppRank != null ? `#${e.oppRank}` : 'Unranked';
      const spotsLabel = e.spots != null ? (e.spots > 0 ? `+${e.spots}` : `${e.spots}`) : '';
      return `${rankLabel}${spotsLabel ? ` <span class="h2h-record-dim">(${spotsLabel})</span>` : ''}`;
    };
    // For tiles that aren't "vs. an opponent" (streaks, podium rate, rating
    // milestones) — same .h2h-tile shell as h2hRow, just a plain value.
    const statTile = (label, valueHtml, iconKey, flip, mobileLabel) => `<div class="h2h-tile"><span class="h2h-label">${h2hIcon(iconKey, flip)}${dualLabelHtml(label, mobileLabel)}</span><span class="h2h-value">${valueHtml}</span></div>`;

    // Podium/Top 8 rate is a Match Statistics tile -- like the rest of that
    // section, doubles placements don't count toward it (see the isDoubles
    // guards elsewhere in this file), only hist.placements' singles entries.
    const singlesPlacements = hist.placements.filter((pl) => !pl.isDoubles);
    const totalPlacements = singlesPlacements.length;
    const podiumCount = singlesPlacements.filter((pl) => pl.rank <= 3).length;
    const top8Count = singlesPlacements.filter((pl) => pl.rank <= 8).length;
    const rateValue = (count) => totalPlacements
      ? `${count}/${totalPlacements} <span class="h2h-record-dim">(${((count / totalPlacements) * 100).toFixed(0)}%)</span>`
      : '&mdash;';

    // Giant-killer/upset-victim counts show the 150+ tier as the headline
    // number, with the rarer 200+ tier called out alongside it when there
    // are any — a player with zero 200+ wins doesn't need "0 (200+)" noise.
    const gapTierValue = (count, majorCount) => count
      ? `&times;${count} <span class="h2h-record-dim">(150+)</span>${majorCount ? ` <span class="h2h-record-dim">&middot; ${majorCount} (200+)</span>` : ''}`
      : '&mdash;';

    const peakRating = ratingHistory.length
      ? ratingHistory.reduce((best, h) => (!best || h.rating > best.rating ? h : best), null)
      : null;

    const h2hSection = `<div class="h2h-grid">
${h2hRow('Best Win Rate (Min. 3)', h2h.bestWinRate, (e) => `${(e.winPct * 100).toFixed(0)}% <span class="h2h-record-dim">(${e.wins}-${e.losses})</span>`, 'trendUp', undefined, 'Best Win Rate')}
${h2hRow('Worst Win Rate (Min. 3)', h2h.worstWinRate, (e) => `${(e.winPct * 100).toFixed(0)}% <span class="h2h-record-dim">(${e.wins}-${e.losses})</span>`, 'trendUp', true, 'Worst Win Rate')}
${h2hRow('Most Wins Against', h2h.mostWinsAgainst, (e) => `&times;${e.wins}`, 'swords', undefined, 'Most Wins Vs')}
${h2hRow('Most Losses Against', h2h.mostLossesAgainst, (e) => `&times;${e.losses}`, 'shield', undefined, 'Most Losses Vs')}
${h2hRow('Most Played', h2h.mostPlayed, (e) => `&times;${e.total}`, 'loop')}
${h2hRow('Rival (Min. 3)', h2h.rival, (e) => `${(e.winPct * 100).toFixed(0)}% <span class="h2h-record-dim">(${e.wins}-${e.losses})</span>`, 'vs', undefined, 'Rival')}
${h2hRow('Best Win', bestWin, bestWinMetric, 'star')}
${statTile('Peak Rating', peakRating ? `<a href="../tournaments/${escapeHtml(peakRating.slug)}.html">${peakRating.rating}</a> <span class="h2h-record-dim">${escapeHtml(formatDateHuman(peakRating.date))}</span>` : '&mdash;', 'mountain')}
${statTile('Longest Win Streak', `${h2h.longestWinStreak}`, 'flame')}
${statTile('Longest Loss Streak', `${h2h.longestLossStreak}`, 'snowflake')}
${statTile('Podium Rate (Top 3)', rateValue(podiumCount), 'podium', undefined, 'Top 3 Rate')}
${statTile('Top 8 Rate', rateValue(top8Count), 'brackets')}
${statTile('Giant Killer Wins', gapTierValue(h2h.giantKiller, h2h.giantKillerMajor), 'breakout')}
${statTile('Upset Victim Losses', gapTierValue(h2h.upsetVictim, h2h.upsetVictimMajor), 'breakoutDown', undefined, 'Upset Losses')}
</div>`;

    const historyRows = paginatedListHtml(placementsDesc, 'tournament-history-list', (pl, hidden) => {
      const histFlagImg = pl.flag ? `<img class="loc-flag" src="${escapeHtml(pl.flag.src)}" title="${escapeHtml(pl.flag.title)}" alt="${escapeHtml(pl.flag.title)}">` : '';
      let doublesPill = '';
      if (pl.isDoubles) {
        const partnerHref = playerHref(pl.partnerId, '../');
        const partnerNameHtml = partnerHref ? `<a href="${escapeHtml(partnerHref)}">${escapeHtml(pl.partnerName)}</a>` : escapeHtml(pl.partnerName);
        doublesPill = ` <span class="doubles-pill doubles-pill-plain">w/ ${partnerNameHtml}</span>`;
      }
      return `      <li${hidden ? ' hidden' : ''}><span class="standings-rank"><span class="rank-ordinal">${ordinal(pl.rank)}<span class="rank-total">/${pl.totalEntrants}</span></span> <span class="hist-record">${pl.wins}-${pl.losses}</span></span><span class="hist-tourney-name">${histFlagImg}<a href="../tournaments/${escapeHtml(pl.slug)}.html">${escapeHtml(pl.label)}</a>${doublesPill}</span><span class="standings-record">${dateDualHtml(pl.date)}</span></li>`;
    },
      'No tournaments on record.');

    // Doubles section: one full-width card per unique partner, styled like
    // the Doubles tab's team cards (same background glow, same "Name &
    // Name" / "N tournaments · W-L (pct%)" header), with every tournament
    // that player+partner entered together and the team's own
    // record/placement there (buildDoublesHistories) listed underneath --
    // deliberately separate from the top-of-page stats/Match
    // Statistics/match log above, which never include doubles results at all.
    const doublesHist = doublesHistories.get(id);
    const doublesSectionHtml = doublesHist && doublesHist.partners.size
      ? `<div class="tourney-section doubles-col">
  <h2>Doubles Teams</h2>
  <div class="doubles-grid">
${[...doublesHist.partners.values()]
    .sort((a, b) => b.entries.length - a.entries.length || a.name.localeCompare(b.name))
    .map((partner) => {
      const pWins = partner.entries.reduce((sum, e) => sum + e.wins, 0);
      const pLosses = partner.entries.reduce((sum, e) => sum + e.losses, 0);
      const games = pWins + pLosses;
      const winPct = games > 0 ? Math.round((pWins / games) * 100) : 0;
      const partnerHref = playerHref(partner.id, '../');
      const partnerFlagImg = playerFlagImg(partner.id, partner.name);
      const partnerNameHtml = partnerHref ? `<a href="${escapeHtml(partnerHref)}">${partnerFlagImg}${escapeHtml(partner.name)}</a>` : `${partnerFlagImg}${escapeHtml(partner.name)}`;
      const accent = teamCardAccent({ id, name }, { id: partner.id, name: partner.name });
      const entriesDesc = [...partner.entries].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const entriesHtml = entriesDesc.map((e) => `      <li><span class="standings-rank"><span class="rank-ordinal">${ordinal(e.rank)}<span class="rank-total">/${e.totalEntrants}</span></span> <span class="hist-record">${e.wins}-${e.losses}</span></span><span class="hist-tourney-name"><a href="../tournaments/${escapeHtml(e.slug)}.html">${escapeHtml(e.label)}</a></span><span class="standings-record">${escapeHtml(formatDateHuman(e.date))}</span></li>`).join('\n');
      return `    <div class="doubles-card ${accent}">
      <div class="doubles-card-names">${flagImg}${escapeHtml(name)} <span class="doubles-amp">&amp;</span> ${partnerNameHtml}</div>
      <div class="doubles-card-stats"><span>${partner.entries.length} tournament${partner.entries.length === 1 ? '' : 's'}</span><span class="doubles-sep">&middot;</span><span>${pWins}-${pLosses} (${winPct}%)</span></div>
      <ol class="standings-list">
${entriesHtml}
      </ol>
    </div>`;
    }).join('\n')}
  </div>
</div>`
      : '';

    const hasChart = ratingHistory.length >= 2;

    // The full "Also known as: ..." caption stays in the meta line for
    // desktop (aka-full is only hidden below the mobile breakpoint) -- on
    // mobile it's replaced by a plain toggle button next to the name (see
    // akaToggle) plus a separate full-width row between the name and the
    // location/active meta line (see akaContentRow), off by default so a
    // long alias list doesn't push the rest of the page down before anyone
    // asks for it. Deliberately a real <button> + a sibling block rather
    // than <details>/<summary> -- a disclosure marker shifts/rotates in
    // place, and here the names need to land in their own row, not right
    // next to the toggle, so the toggle's own position must never move
    // regardless of open state.
    const aliasCaption = aliases.length
      ? `<span class="alias-list aka-full">Also known as: ${aliases.map(escapeHtml).join(', ')}</span>`
      : '';
    const akaToggle = aliases.length
      ? `<button class="aka-toggle" type="button" aria-expanded="false" aria-controls="aka-content">AKA <svg class="aka-caret" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg></button>`
      : '';
    const akaContentRow = aliases.length
      ? `<div class="aka-content" id="aka-content">AKA: ${aliases.map(escapeHtml).join(', ')}</div>`
      : '';
    const activeCaption = activeRange ? `<span class="alias-list">Active ${escapeHtml(activeRange)}</span>` : '';
    const metaLine = location || activeCaption || aliasCaption
      ? `<div class="tourney-meta">${location ? `<span>${flagImg}${escapeHtml(location)}</span>` : ''}${activeCaption}${aliasCaption}</div>`
      : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} — DeathBall Power Rankings</title>
<link rel="stylesheet" href="../index.css">
</head>
<body class="${cardAccent(id, info.color)}">
<div class="player-title-row"><h1>${escapeHtml(name)}</h1>${akaToggle}</div>
${akaContentRow}
${metaLine}
<a class="back-link" href="../index.html">&larr; Back to rankings</a>

${isDoublesOnly
  ? `<div class="player-grid doubles-only-grid">
  <div class="tourney-section tournaments-col">
    <h2>Tournaments (${p.tournaments.size})</h2>
    ${historyRows}
  </div>
${doublesSectionHtml}
</div>`
  : `<div class="tourney-section">
  <h2 class="mobile-only-heading">Essential Stats</h2>
  <div class="player-stats-grid">
${statTiles}
${goalsTile}
${rankingTiles}
  </div>
</div>

${hasChart
  ? `<div class="player-grid">
  <div class="tourney-section chart-col">
    <h2>Historical Rating</h2>
    ${buildRatingChartSvg(ratingHistory)}
  </div>

  <div class="tourney-section h2h-col">
    <h2>Match Statistics</h2>
    ${h2hSection}${doublesSectionHtml}
  </div>

  <div class="tourney-section matches-col">
    <h2>Matches (${p.games})</h2>
    ${recentMatchesHtml}
  </div>

  <div class="tourney-section tournaments-col">
    <h2>Tournaments (${p.tournaments.size})</h2>
    ${historyRows}
  </div>
</div>`
  : `<div class="player-columns">
  <div class="tourney-section player-col">
    <h2>Matches (${p.games})</h2>
    ${recentMatchesHtml}
  </div>

  <div class="tourney-section player-col">
    <h2>Tournaments (${p.tournaments.size})</h2>
    ${historyRows}
  </div>

  <div class="tourney-section player-col">
    <h2>Match Statistics</h2>
    ${h2hSection}${doublesSectionHtml ? `
    ${doublesSectionHtml}` : ''}
  </div>
</div>`}`}
<script>
  document.querySelectorAll('.show-more-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const list = document.getElementById(btn.dataset.list);
      const hiddenItems = [...list.children].filter((li) => li.hidden).slice(0, ${PAGE_SIZE});
      hiddenItems.forEach((li) => { li.hidden = false; });
      if (![...list.children].some((li) => li.hidden)) btn.hidden = true;
    });
  });

  // Mobile-only AKA disclosure (see .aka-toggle/.aka-content in writeCss) --
  // a plain button + a separate content block, not <details>, so the toggle
  // itself never moves and the alias list lands in its own full-width row
  // below the location/active line instead of right next to the button.
  (() => {
    const toggle = document.querySelector('.aka-toggle');
    const content = document.getElementById('aka-content');
    if (!toggle || !content) return;
    toggle.addEventListener('click', () => {
      const open = content.classList.toggle('open');
      toggle.classList.toggle('active', open);
      toggle.setAttribute('aria-expanded', String(open));
    });
  })();

  // Historical-rating chart: hover/focus a tournament point to show its
  // tooltip, positioned against the chart's inner box (its actual
  // containing block, not the viewport or the padded outer card), so it
  // scales correctly with the SVG's own preserveAspectRatio scaling.
  document.querySelectorAll('.rating-chart-inner').forEach((wrap) => {
    const tooltip = wrap.querySelector('.chart-tooltip');
    const svg = wrap.querySelector('.rating-chart');
    if (!tooltip || !svg) return;
    const show = (point) => {
      const wrapRect = wrap.getBoundingClientRect();
      const pointRect = point.getBoundingClientRect();
      tooltip.innerHTML = '<strong>' + point.dataset.label + '</strong><br>' +
        point.dataset.date + '<br>Rating ' + point.dataset.rating +
        (point.dataset.rank ? ' &middot; Rank #' + point.dataset.rank : '');
      tooltip.hidden = false;
      let left = (pointRect.left - wrapRect.left) + (pointRect.width / 2);
      left = Math.max(60, Math.min(left, wrapRect.width - 60));
      tooltip.style.left = left + 'px';
      tooltip.style.top = (pointRect.top - wrapRect.top) + 'px';
    };
    const hide = () => { tooltip.hidden = true; };
    const points = [...svg.querySelectorAll('.chart-point')];
    points.forEach((point) => {
      point.addEventListener('focus', () => show(point));
      point.addEventListener('blur', hide);
    });
    // Nearest-point-by-x detection across the whole chart (not just when
    // hovering a point's small hit circle) — find the closest marker to the
    // mouse's x position anywhere over the SVG and show its tooltip.
    svg.addEventListener('mousemove', (e) => {
      if (!points.length) return;
      let nearest = points[0];
      let nearestDist = Infinity;
      for (const p of points) {
        const r = p.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const dist = Math.abs(e.clientX - cx);
        if (dist < nearestDist) { nearestDist = dist; nearest = p; }
      }
      show(nearest);
    });
    svg.addEventListener('mouseleave', hide);
  });
</script>
${siteFooter('../')}
</body>
</html>
`;

    keep.add(`${slug}.html`);
    fs.writeFileSync(path.join(dir, `${slug}.html`), html);
  }

  cleanStaleHtml(dir, keep);
}

async function main() {
  const challongeTournaments = collectChallonge();
  const startggTournaments = collectStartgg();
  const allTournaments = [...challongeTournaments, ...startggTournaments];

  allTournaments.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  assignSlugs(allTournaments);

  const knownUrls = new Set(allTournaments.map((t) => t.url));
  const manualByUrl = loadManualMatches(knownUrls);
  for (const t of allTournaments) {
    const manual = manualByUrl.get(t.url) || [];
    if (manual.length === 0) continue;
    // Manual entries with a match_index replace the scraped match for that
    // slot — inherit its structural fields (round/order/groupId/stageKind)
    // so the replacement stays correctly positioned in the bracket; only the
    // recorded result (winner/scores/games) comes from the manual entry.
    // Without this, a corrected match would lose its round/order entirely,
    // which splitStages would then see as a whole separate (metadata-less)
    // stage, silently carving it out of the bracket and leaving a gap that
    // cascaded into spurious extra byes everywhere downstream of it.
    const byIdentifier = new Map(t.matches.map((m) => [m.identifier, m]));
    const merged = manual.map((m) => {
      if (!m.matchIndex) return m;
      const original = byIdentifier.get(m.matchIndex);
      return original
        ? { ...m, round: original.round, order: original.order, groupId: original.groupId, stageKind: original.stageKind }
        : m;
    });
    const overrideIds = new Set(manual.map((m) => m.matchIndex).filter(Boolean));
    if (overrideIds.size > 0) {
      t.matches = t.matches.filter((m) => !overrideIds.has(m.identifier));
    }
    t.matches.push(...merged);
  }

  // Hidden identities (byes, walkovers, placeholder entrants like "D1"/
  // "nobody") never happened as far as display is concerned — drop any
  // match involving one, and drop them from the participant roster so they
  // never show up in standings or the round-robin crosstable either.
  for (const t of allTournaments) {
    t.matches = t.matches.filter((m) =>
      !hiddenNames.has(normName(m.winnerName).toLowerCase()) &&
      !hiddenNames.has(normName(m.loserName).toLowerCase()));
    t.participantList = t.participantList.filter((p) => !hiddenNames.has(normName(p.name).toLowerCase()));
  }

  for (const t of allTournaments) {
    t.stages = splitStages(t);
    for (const stage of t.stages) {
      stage.bracketData = await buildBracketData(stage.tLike);
      if (stage.bracketData) {
        // Resolve while the raw in-tournament name is still available —
        // alias/split resolution keys off raw names, so it can't reliably
        // be re-run later against the canonical name this replaces it with.
        // The flag rides along for the bracket page to render next to the
        // name; it's stripped back out of the payload handed to
        // brackets-viewer (see writeTournamentPages).
        for (const p of stage.bracketData.participants) {
          const resolved = resolveDisplayName(p.name, t.url);
          p.name = resolved.name;
          p.flag = resolved.flag || null;
        }
      }
    }
  }

  const players = new Map();
  const glicko = new Map();
  const preTournamentRatings = new Map();
  const snapshots = [];
  processChronologically(allTournaments, players, glicko, preTournamentRatings, snapshots);
  registerDoublesParticipants(allTournaments, players);

  const tournamentMetaByUrl = new Map(allTournaments.map((t) => [t.url, { location: t.location, slug: t.slug }]));
  // Last active = the most recent tournament date among a player's own
  // tournaments, cross-referenced against allTournaments (players only
  // track which tournament URLs they played, not dates).
  const urlToDate = new Map(allTournaments.map((t) => [t.url, t.date]));
  const lastActiveById = new Map();
  for (const [id, p] of players.entries()) {
    let last = '';
    for (const url of p.tournaments.keys()) {
      const d = urlToDate.get(url);
      if (d && d > last) last = d;
    }
    lastActiveById.set(id, last);
  }
  const playerRows = buildPlayerRows(players, tournamentMetaByUrl, lastActiveById);

  // Each snapshot's ratings map covers everyone who'd played by that point,
  // so ranking it the same way buildRankingRows does (conservative rating,
  // descending) reconstructs "the leaderboard as of that tournament."
  const snapshotRanks = snapshots.map((s) => {
    const sorted = [...s.ratings.entries()]
      .map(([id, g]) => [id, glicko2.conservativeRating(g)])
      .sort((a, b) => b[1] - a[1]);
    return new Map(sorted.map(([id], i) => [id, i + 1]));
  });

  // One checkpoint per tournament *group* (groupIdFor/tournament-groups.json
  // — a multi-bracket event collapses to one point), in chronological order.
  // participantIds is the union of everyone who actually played *any*
  // tournament in that group (not just the last one) -- used below to gate
  // the rank-delta badge so a player who sat out the most recent group
  // doesn't get an artificial ▼ badge just because a couple of new entrants
  // slotted in above them and pushed the whole unchanged field down a spot.
  const groupSnapshotIndices = new Map();
  snapshots.forEach((s, i) => {
    const gid = groupIdFor(s.url);
    if (!groupSnapshotIndices.has(gid)) groupSnapshotIndices.set(gid, []);
    groupSnapshotIndices.get(gid).push(i);
  });
  const groupCheckpoints = [...groupSnapshotIndices.entries()]
    .map(([groupId, indices]) => {
      const participantIds = new Set();
      for (const idx of indices) for (const id of snapshots[idx].participantIds) participantIds.add(id);
      return { groupId, index: indices[indices.length - 1], participantIds };
    })
    .sort((a, b) => a.index - b.index);

  // "Since the last tournament" for the Rankings tab's up/down badge = comparing
  // current standings to how they stood right before the most recent group
  // played (tournament-groups.json; a group defaults to just its own
  // tournament) — so a multi-bracket event like SGDQ reads as one step, not
  // several, and the badge is gated to that group's own participants (see
  // groupCheckpoints above).
  const currentGroup = groupCheckpoints[groupCheckpoints.length - 1];
  const previousGroup = groupCheckpoints[groupCheckpoints.length - 2];
  const previousRanks = previousGroup ? snapshotRanks[previousGroup.index] : new Map();

  const rankingRows = buildRankingRows(players, glicko, previousRanks, currentGroup ? currentGroup.participantIds : new Set(), lastActiveById);

  // Must run before writeHtml/writeTournamentPages/writePlayerPages — they
  // all link player names via playerHref(), which reads this.
  assignPlayerSlugs(players);
  const histories = buildPlayerHistories(allTournaments, preTournamentRatings);

  // Identity/location fields never vary with the checkpoint, so they're
  // shipped once per player (keyed by id) instead of once per player per
  // checkpoint -- with 100+ checkpoints that repetition would otherwise
  // dominate the payload's size for no benefit.
  const playerMetaById = {};
  for (const [id, p] of players.entries()) {
    const meta = buildPlayerMeta(id, p, lastActiveById);
    playerMetaById[id] = {
      name: meta.name,
      href: playerHref(id, ''),
      location: meta.location,
      locationSort: meta.locationSort,
      flag: meta.flag,
      locAbbr: meta.locAbbr,
      state: meta.state,
      color: meta.color,
      lastActive: meta.lastActive,
    };
  }

  // Positional array, not an object -- with 100+ checkpoints, repeating full
  // key names ("winPct", "placementChange", ...) on every row of every
  // checkpoint was most of this payload's weight. winPct/uncertain are
  // cheap to recompute client-side (wins/games, rd > threshold) so they
  // aren't shipped at all. Order: [id, r, rd, wins, losses, games, isNew,
  // placementChange] -- keep normalizeRow() in writeJs() in sync with this.
  const toClientRow = (r) => [
    r.id,
    Math.round(r.r),
    Math.round(r.rd),
    r.wins,
    r.losses,
    r.games,
    !!r.isNew,
    r.placementChange == null ? null : r.placementChange,
  ];

  // The final checkpoint always reuses the already-computed live rankingRows
  // (same data, same previousRanks boundary) instead of recomputing it, so
  // the default "current" view in the dropdown matches the page's default
  // render exactly.
  const rankingCheckpoints = groupCheckpoints.map(({ groupId, index, participantIds }, i) => {
    const snap = snapshots[index];
    const isLatest = i === groupCheckpoints.length - 1;
    let rows;
    if (isLatest) {
      rows = rankingRows;
    } else {
      const checkpointPreviousRanks = i > 0 ? snapshotRanks[groupCheckpoints[i - 1].index] : new Map();
      rows = buildRankingRowsAt(players, snap.ratings, snap.stats, checkpointPreviousRanks, participantIds);
    }
    return {
      groupId,
      // tournamentGroups[snap.url] is the human-edited group name
      // (tournament-groups.json) when this checkpoint's last tournament
      // belongs to a real group (e.g. "SGDQ 2024" instead of that one
      // bracket's own individual label) -- falls back to the tournament's
      // own label when it's a singleton group.
      label: tournamentGroups[snap.url] || snap.label,
      date: snap.date,
      dateLabel: formatMonthCommaYear(snap.date),
      isLatest,
      rows: rows.map(toClientRow),
    };
  });
  const rankingHistory = { players: playerMetaById, checkpoints: rankingCheckpoints };

  // Per-player rating history: one point per tournament a player actually
  // competed in (not every tournament — most players skip most events, and
  // their rating doesn't move on a tournament they sat out), in chronological
  // order. Powers the rating-over-time graph on player pages. Rank is the
  // player's overall standing in that same snapshot (see snapshotRanks
  // above), i.e. "where they stood right after this tournament," not their
  // current rank.
  const ratingHistoryById = new Map();
  snapshots.forEach((s, i) => {
    const ranks = snapshotRanks[i];
    for (const id of s.participantIds) {
      const g = s.ratings.get(id);
      if (!g) continue;
      if (!ratingHistoryById.has(id)) ratingHistoryById.set(id, []);
      ratingHistoryById.get(id).push({
        date: s.date,
        label: s.label,
        slug: s.slug,
        rating: Math.round(glicko2.conservativeRating(g)),
        rd: Math.round(g.rd),
        rank: ranks.get(id) || null,
      });
    }
  });

  // Doubles tournaments never touch the Glicko engine and, per request,
  // don't show up on the Historical Rating chart either -- ratingHistoryById
  // is built purely from `snapshots` above, which already never contains a
  // doubles tournament (processChronologically skips them before ever
  // pushing one). buildDoublesHistories still powers the player page's
  // separate Doubles section (partner/tournament breakdown), just not the chart.
  const doublesHistories = buildDoublesHistories(allTournaments);

  // Map sidebar player lists are alphabetical (not rank order) and only
  // include players with a resolved location — even the unfiltered "All
  // States" list, since an unlocatable player can't meaningfully belong to
  // any region anyway. `rank` still reflects each player's real overall
  // Power Ranking position (looked up from the rank-ordered rankingRows
  // before re-sorting alphabetically), just displayed in an alpha-sorted list.
  const rankById = new Map(rankingRows.map((p, i) => [p.id, i + 1]));
  const toMapPlayer = (p) => ({
    name: p.name,
    href: playerHref(p.id, ''),
    rank: rankById.get(p.id),
    rating: Math.round(p.r),
    rd: Math.round(p.rd),
    lastActive: formatMonthYearHuman(lastActiveById.get(p.id)),
    flag: p.flag,
  });
  const locatedPlayersAlpha = rankingRows
    .filter((p) => p.state)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const mapAllPlayers = locatedPlayersAlpha.map(toMapPlayer);
  const regionPlayers = new Map();
  for (const p of locatedPlayersAlpha) {
    const abbr = regionAbbr(p.state);
    if (!abbr) continue;
    if (!regionPlayers.has(abbr)) regionPlayers.set(abbr, []);
    regionPlayers.get(abbr).push(toMapPlayer(p));
  }

  // Tournament dates are pre-formatted human-readable ("May 23, 2026") at
  // generation time — sort by the raw ISO date first, then format, since
  // sorting the formatted strings would order by month name instead of time.
  const toMapTournament = (t) => ({ label: t.label, href: `tournaments/${t.slug}.html`, date: formatDateHuman(t.date), dateIso: t.date, flag: t.locationDisplay.flag });
  const mapAllTournaments = [...allTournaments].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(toMapTournament);
  const regionTournamentsRaw = new Map();
  for (const t of allTournaments) {
    const abbr = regionAbbr(t.state);
    if (!abbr) continue;
    if (!regionTournamentsRaw.has(abbr)) regionTournamentsRaw.set(abbr, []);
    regionTournamentsRaw.get(abbr).push(t);
  }
  const regionTournaments = new Map();
  for (const [abbr, list] of regionTournamentsRaw) {
    regionTournaments.set(abbr, [...list].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(toMapTournament));
  }

  // A region's geometric centroid isn't always where its label should sit
  // (e.g. a state with a panhandle, or two land masses joined by water) —
  // nudge specific labels toward the state's visually-recognizable body.
  const LABEL_OFFSETS = {
    CA: [0, 18],   // centroid sits high (pulled up by the wide NorCal/OR border); drop toward the main body
    FL: [9, 0],    // centroid pulled west by the panhandle; shift toward the peninsula
    MI: [10, 23],  // centroid falls in Lake Huron between the UP and the mitten; shift into the mitten
  };

  const mapRegions = mapShapes.shapes.map((s) => {
    const [dx, dy] = LABEL_OFFSETS[s.id] || [0, 0];
    return {
      id: s.id,
      name: STATE_NAMES[s.id] || s.id,
      d: s.d,
      cx: Math.round((s.cx + dx) * 10) / 10,
      cy: Math.round((s.cy + dy) * 10) / 10,
      players: (regionPlayers.get(s.id) || []).length,
      tournaments: (regionTournaments.get(s.id) || []).length,
      playersList: regionPlayers.get(s.id) || [],
      tournamentsList: regionTournaments.get(s.id) || [],
    };
  });

  const doublesTeams = buildDoublesTeams(allTournaments);

  writeCsv(playerRows);
  writeCss();
  writeJs();
  writeHtml(playerRows, allTournaments, rankingRows, mapRegions, mapAllPlayers, mapAllTournaments, rankingHistory, doublesTeams);
  writeTournamentPages(allTournaments);
  writePlayerPages(players, glicko, histories, rankingRows, ratingHistoryById, doublesHistories);

  console.log(`Unique players: ${playerRows.length}`);
  console.log(`Tournaments:    ${allTournaments.length}`);
  console.log(`Ranked players: ${rankingRows.length}`);
  console.log(`Output: ${path.join(__dirname, 'players.csv')}`);
  console.log(`Output: ${path.join(REPO_ROOT, 'index.html')}`);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });

module.exports = {
  DATA_ROOT,
  identities,
  hiddenNames,
  normName,
  resolveIdentity,
  displayName,
  collectChallonge,
  collectStartgg,
  buildPlayerStats,
  parseTeamName,
};
