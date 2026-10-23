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
const { buildBracketData, hashStr } = require('./build_bracket');
const { slugify } = require('../slugify');
const { writeCss, writeJs, stripCommentsInHeadBlocks } = require('./generate_output');

const DATA_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(__dirname, '..', '..');

// Base URL for og:url on every generated page (Discord/Twitter/etc link
// embeds). No canonical domain is configured anywhere else in the repo
// (no CNAME, no Pages workflow) -- this is the GitHub Pages URL the site
// is actually served from.
const SITE_URL = 'https://lilylavender.github.io/deathball-power-rankings/';

// Shared Open Graph / Twitter Card tags for link-unfurling embeds (Discord,
// Twitter/X, Slack, etc). No og:image is set -- the site has no per-page
// preview image, and Discord/Twitter still render a title+description card
// without one.
function embedMetaTags(title, description, urlPath) {
  return `<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(SITE_URL + urlPath)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="DeathBall Power Rankings" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />`;
}

// Inlined as data: URIs at build time rather than referenced by path -- a
// relative same-origin <img src> can silently fail to load if the page is
// ever opened as a local file:// URL instead of served over http(s), and
// (separately) the download feature's own image-inlining step can't fetch()
// a file:// resource at all. Baking them in removes the runtime dependency
// entirely, for both cases.
function assetDataUri(relativePath, mime) {
  const buf = fs.readFileSync(path.join(REPO_ROOT, relativePath));
  return `data:${mime || 'image/png'};base64,${buf.toString('base64')}`;
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
// entries) to its abbreviation, for keying into mapShapes/STATE_NAMES. Falls
// back to a country-level region (matching mapShapes' non-US/CA shapes,
// keyed by COUNTRY_CODES' abbr, e.g. "DEU"/"UK") when there's no state --
// the normal case for players/tournaments outside the US and Canada, which
// only get whole-country shapes rather than state/province-level ones.
function regionAbbr(rawState, country) {
  if (rawState) {
    if (STATE_NAMES[rawState]) return rawState;
    if (STATE_ABBR_BY_NAME[rawState]) return STATE_ABBR_BY_NAME[rawState];
  }
  if (country) return (COUNTRY_CODES[country] || {}).abbr || '';
  return '';
}

// State-only half of regionAbbr: a raw player-info.json state value, whether
// abbreviated ("ON") or spelled out ("Ontario"), to its abbreviation. The
// Location filter dropdown keys players by this, so both spellings of a
// province land in the same entry instead of showing up as two. Unknown
// values pass through untouched.
function stateKeyFor(rawState) {
  if (!rawState) return '';
  if (STATE_NAMES[rawState]) return rawState;
  return STATE_ABBR_BY_NAME[rawState] || rawState;
}

// Display name + flag for every region/country the Location filter can
// list (populateStateFilter in generate_output.js builds the actual option
// list from the rows' data-state/data-country attributes and looks names
// and flags up here), embedded in index.html as #location-filter-data so
// the client never has to re-derive flag URLs.
function buildLocationFilterData() {
  const regions = {};
  for (const [abbr, name] of Object.entries(STATE_NAMES)) {
    const country = CA_PROVINCE_FLAGS[name] ? 'Canada' : 'United States';
    regions[abbr] = { name, country, flag: flagForInfo({ state: abbr, country }) };
  }
  const countries = {};
  for (const country of Object.keys(COUNTRY_CODES)) {
    countries[country] = { flag: flagForInfo({ country }) };
  }
  return { regions, countries };
}

// data-state / data-country attributes for a player row or card, read by
// the Location filter (applyFilters/populateStateFilter in generate_output.js).
function locationDataAttrs(p) {
  return (p.locationKey ? ` data-state="${escapeHtml(p.locationKey)}"` : '')
    + (p.country ? ` data-country="${escapeHtml(p.country)}"` : '');
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
// A canonical display name shared by more than one distinct backend id (a
// split, e.g. two unrelated "Parker"s) must never resolve player-info.json
// through that shared name -- only through the id -- or a brand-new split
// resolution silently inherits an unrelated old player's location/color
// keyed under the plain name (see CLAUDE.md's player-info.json note on
// keying split entries by id). Names with just one id behind them (most
// aliases, e.g. "James Matthews") are unambiguous and can still fall back
// to a name-keyed entry.
const canonicalNameIds = new Map();
function trackCanonicalName(id, canonical) {
  if (!id || !canonical) return;
  if (!canonicalNameIds.has(canonical)) canonicalNameIds.set(canonical, new Set());
  canonicalNameIds.get(canonical).add(id);
}
for (const a of identities.aliases || []) trackCanonicalName(a.id || a.canonical.toLowerCase(), a.canonical);
for (const s of identities.splits || []) {
  for (const r of s.resolutions || []) trackCanonicalName(r.id, r.canonical);
  if (s.default) trackCanonicalName(s.default.id, s.default.canonical);
}
const ambiguousCanonicalNames = new Set(
  [...canonicalNameIds].filter(([, ids]) => ids.size > 1).map(([name]) => name)
);
function lookupPlayerInfo(id, name) {
  if (playerInfo[id]) return playerInfo[id];
  const byIdLower = playerInfoByLowerKey.get((id || '').toLowerCase());
  if (byIdLower) return byIdLower;
  if (name && !ambiguousCanonicalNames.has(name)) {
    if (playerInfo[name]) return playerInfo[name];
    const byNameLower = playerInfoByLowerKey.get(name.toLowerCase());
    if (byNameLower) return byNameLower;
  }
  return {};
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
// Flat map of team nickname (exactly as registered in the bracket, e.g.
// "Team Ramrod") -> { displayName, players: [{id,name}, {id,name}] }, for
// doubles teams whose raw registration name can't be split into two player
// names via parseTeamName at all -- a nickname reveals nothing about who's
// actually on the team, so add_tournaments.js resolves each member manually
// (new player / existing player / an "Unnamed Player" placeholder identity
// for someone whose real name isn't known) and records the result here.
// Optional/empty-safe like the other manual dedup configs.
const teamNames = readJson(path.join(DATA_ROOT, 'team-names.json'), {});

// Doubles-aware identity resolution for a raw team/participant name: splits
// on a separator via parseTeamName and resolves each half the normal way, or
// falls back to a team-names.json entry for a nickname registration. Returns
// [identityA, identityB] (each {id, name}) or null if neither path resolves.
function resolveTeamMembers(rawName, tournamentUrl) {
  const parts = parseTeamName(rawName);
  if (parts) {
    const a = resolveIdentity(parts[0], tournamentUrl);
    const b = resolveIdentity(parts[1], tournamentUrl);
    if (!a.id || !b.id || a.id === b.id) return null;
    return [a, b];
  }
  const entry = teamNames[normName(rawName)];
  if (entry && Array.isArray(entry.players) && entry.players.length === 2) {
    const [a, b] = entry.players;
    if (!a || !b || !a.id || !b.id || a.id === b.id) return null;
    return [a, b];
  }
  return null;
}
// Flat map of tournament URL -> YouTube video URL, for tournaments with a
// VOD available -- optional, powers the "Watch on YouTube" pill on the
// tournament page alongside the "View on Challonge/start.gg" source pill.
const tournamentVideos = readJson(path.join(DATA_ROOT, 'tournament-videos.json'), {});

// Splits a doubles participant/team raw name (e.g. "PlayerA + PlayerB",
// "PlayerA & PlayerB", or "PlayerA and PlayerB") into its two component raw
// player names. Returns null if the name doesn't contain exactly one such
// separator -- e.g. a team registered under a nickname with no player names
// in it at all ("Team Ramrod"), which resolveTeamMembers below falls back to
// team-names.json for instead.
function parseTeamName(rawName) {
  const trimmed = normName(rawName);
  if (!trimmed) return null;
  const parts = trimmed.split(/\s*(?:[+&/]|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean);
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

// The three icons (idle download arrow, spinner, success check) shared by
// both .download-btn instances (PNG export -- see writeHtml's page-title-row
// and rankings-options-panel markup), stacked in one .download-icon-slot
// grid cell so the downloadBtn click handler (see enableViewToggle in
// generate_output.js) can cross-fade between them via the slot's data-state
// instead of a hard display:none/block swap. Not used by the CSV export
// buttons (csvDownloadButtonHtml below) since those are synchronous and
// never show a loading/success state. Checkmark path length (15) is a
// static measurement of the M3.5 8.5L6.5 11.5L12.5 4.5 path below -- see the
// success-check reference's "Calibrating stroke-dasharray" note.
function downloadIconSlotHtml() {
  return `<span class="download-icon-slot" data-state="idle"><svg class="download-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8"/><path d="M4.5 7L8 10.5 11.5 7"/><path d="M2.5 12.5h11"/></svg><svg class="download-spinner" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M14 8a6 6 0 1 1-2-4.47"/></svg><span class="t-success-check download-check" data-state="out" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5L6.5 11.5L12.5 4.5"/></svg></span></span>`;
}

// A CSV-export button, styled/iconed identically to the PR tab's PNG
// download button (see .download-btn-boxed in generate_output.js) but kept
// off the .download-btn class so it isn't swept into that button's
// grid-view-only show/hide logic (updateDownloadVisibility) -- this one gets
// its own, separate show/hide rule for the Power Rankings tab instance (see
// updateCsvDownloadVisibility in writeJs). datasetKey selects which embedded
// JSON blob (see CSV_PLAYER_DATA/CSV_TOURNAMENT_DATA in writeHtml) to export
// at click time (see enableCsvDownloadButtons in writeJs) -- the Power
// Rankings tab's button deliberately shares the Players tab's 'players'
// dataset (rather than building its own), so both "return the same data"
// per product ask. startHidden marks the one instance (Power Rankings tab)
// whose default view on load (Grid) should NOT show it, avoiding a flash of
// a visible button before enableViewToggle's first updateCsvDownloadVisibility
// call hides it.
function csvDownloadButtonHtml(datasetKey, filenamePrefix, startHidden) {
  return `<button class="csv-download-btn download-btn-boxed" type="button" data-csv-key="${escapeHtml(datasetKey)}" data-csv-filename="${escapeHtml(filenamePrefix)}"${startHidden ? ' hidden' : ''}><svg class="download-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8"/><path d="M4.5 7L8 10.5 11.5 7"/><path d="M2.5 12.5h11"/></svg><svg class="download-spinner" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M14 8a6 6 0 1 1-2-4.47"/></svg><span class="download-btn-label">Download CSV</span></button>`;
}

// Real favicons for the source pills, embedded once as data URIs -- see
// assetDataUri(). Challonge's is their site favicon.ico (flame mark);
// start.gg's is their apple-touch-icon.png (the blue/pink "S" mark), which
// is much higher-res than their favicon.ico (a near-blank 4bpp icon).
const CHALLONGE_ICON_URI = assetDataUri('assets/challonge-icon.ico', 'image/x-icon');
const STARTGG_ICON_URI = assetDataUri('assets/startgg-icon.png');

// "View on Challonge/start.gg" pill for the tournament-page header -- the
// source's real favicon plus its name, styled like .doubles-pill.
function sourcePillHtml(url, source) {
  const isChallonge = source === 'Challonge';
  const cls = isChallonge ? 'source-pill-challonge' : 'source-pill-startgg';
  const icon = `<img src="${isChallonge ? CHALLONGE_ICON_URI : STARTGG_ICON_URI}" alt="">`;
  return `<a class="source-pill ${cls}" href="${escapeHtml(url)}" target="_blank" rel="noopener">${icon}${escapeHtml(source)}</a>`;
}

// "Watch on YouTube" pill, shown next to the source pill when a VOD is
// registered in data/tournament-videos.json for this tournament's URL.
function youtubePillHtml(videoUrl) {
  const icon = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="3" width="14" height="10" rx="3" fill="#FF0000"/><path d="M6.5 5.5l4 2.5-4 2.5z" fill="#fff"/></svg>';
  return `<a class="source-pill source-pill-youtube" href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener">${icon}YouTube</a>`;
}

function resolveDate(url, builtIn) {
  return tournamentLocations[url]?.date || builtIn;
}

// Same-day tiebreaker for two tournaments whose `date` (after resolveDate's
// override) ends up identical -- e.g. a one-day event's singles and doubles
// brackets, which Challonge/start.gg's own started_at timestamps can't be
// trusted to order (see the QuakeCon Arcade 2026 case: the two brackets'
// started_at even disagreed on the calendar day, forcing a manual date
// override in the first place). Only meaningful relative to other
// tournaments sharing the same date -- defaults to 0, so every tournament
// without an explicit order sorts as if tied with every other unset one.
function resolveDateOrder(url) {
  return tournamentLocations[url]?.order || 0;
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
      dateOrder: resolveDateOrder(url),
      location: formatLocation(locInfo),
      locationDisplay: locationDisplay(locInfo),
      venue: locInfo?.location || '',
      city: locInfo?.city || '',
      state: locInfo?.state || '',
      country: locInfo?.country || 'United States',
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
        // Distinguishes a swiss pool from a round-robin one when a
        // tournament splits into multiple pool stages -- splitStages uses
        // this to keep a swiss pool rendering as a round-list instead of
        // being lumped in with round-robin's crosstable. Challonge has no
        // per-match equivalent (its group-stage feature is always
        // round-robin pools), so this stays unset there.
        groupBracketType: bracketType === 'SWISS' ? 'swiss' : bracketType === 'ROUND_ROBIN' ? 'round robin' : null,
        // Raw start.gg bracketType (e.g. "DOUBLE_ELIMINATION"), kept
        // separately from groupBracketType above -- that field only ever
        // captures the pool-stage type (swiss/round robin), never the
        // playoff bracket's own elimination format. Used by
        // bracketTypeLabel() for the CSV export's "Bracket type" column.
        bracketType: bracketType || null,
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
      dateOrder: resolveDateOrder(url),
      location: formatLocation(locInfo),
      locationDisplay: locationDisplay(locInfo),
      venue: locInfo?.location || '',
      city: locInfo?.city || '',
      state: locInfo?.state || '',
      country: locInfo?.country || 'United States',
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

const BRACKET_TYPE_LABELS = {
  'single elimination': 'Single Elimination',
  'double elimination': 'Double Elimination',
  'round robin': 'Round Robin',
  swiss: 'Swiss',
  'free for all': 'Free For All',
  SINGLE_ELIMINATION: 'Single Elimination',
  DOUBLE_ELIMINATION: 'Double Elimination',
  ROUND_ROBIN: 'Round Robin',
  SWISS: 'Swiss',
};
function humanizeBracketType(raw) {
  if (!raw) return null;
  return BRACKET_TYPE_LABELS[raw] || BRACKET_TYPE_LABELS[String(raw).toLowerCase()] || null;
}

function mostCommon(values) {
  if (!values.length) return null;
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Human-readable match format for the CSV export's "Bracket type" column --
// e.g. "Double Elimination" for a single-stage bracket, or "Round Robin →
// Single Elimination" when a pool stage feeds into a separate playoff
// bracket (same pool/bracket split splitStages below detects for
// tournament-page rendering, kept independent here to avoid touching that
// shared render path). Challonge's tournament_type covers its own bracket
// stage directly; start.gg has no tournament-level equivalent, so its
// bracket stage's type is inferred from the most common raw bracketType
// among that stage's own matches (see the `bracketType` field added to each
// start.gg match in collectStartgg). Returns null (blank in the CSV) when
// the format can't be determined -- older Challonge fetches predate
// tournament_type capture.
function bracketTypeLabel(t) {
  const poolMatches = t.matches.filter((m) => m.groupId != null);
  const bracketMatches = t.matches.filter((m) => m.groupId == null);
  const poolType = poolMatches.length
    ? humanizeBracketType(poolMatches.find((m) => m.groupBracketType)?.groupBracketType || 'round robin')
    : null;
  const bracketRaw = t.tournamentType || mostCommon(bracketMatches.map((m) => m.bracketType).filter(Boolean));
  const bracketType = humanizeBracketType(bracketRaw);
  if (poolType && bracketMatches.length) return bracketType ? `${poolType} → ${bracketType}` : poolType;
  if (poolType) return poolType;
  return bracketType;
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
    const poolType = stageMatches.find((m) => m.groupBracketType)?.groupBracketType || 'round robin';
    return {
      label: isBracketStage && hasBracketGroup ? 'Playoff Bracket' : poolIds.length > 1 ? `Group ${i + 1}` : 'Group Stage',
      tLike: {
        ...t,
        tournamentType: isBracketStage ? t.tournamentType : poolType,
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
  // Doubles teams must canonicalize through teamCanonicalName (nickname-
  // preferring), not a bare resolveIdentity on the raw team string -- see
  // that function's comment for why a plain resolveIdentity here silently
  // breaks nickname teams' W-L record.
  const canon = (rawName) => (t.isDoubles ? teamCanonicalName(rawName, t) : resolveIdentity(rawName, t.url).name);
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
  const canon = (rawName) => (t.isDoubles ? teamCanonicalName(rawName, t) : resolveIdentity(rawName, t.url).name);
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
  if (m.dq) {
    // Same shape a scraped DQ gets (see the standing.stats.score.value===-1
    // branch below) -- null sets, isDQ true. matchScoreLabel/build_bracket
    // already know to show "DQ" instead of a score for this shape.
    return {
      winnerName: m.p1,
      loserName: m.p2,
      winnerSets: null,
      loserSets: null,
      games: null,
      isDQ: true,
    };
  }

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
        locationSort: [stateKeyFor(info.state) || info.country, info.city].filter(Boolean).join('|').toLowerCase(),
        city: info.city || '',
        state: stateKeyFor(info.state),
        // Same default as flagForInfo's flag lookup -- player-info.json's
        // own schema documents `country` as optional, defaulting to United
        // States when omitted (see player-info.json's _schema).
        country: info.country || 'United States',
        // Location dropdown's region key -- the state/province abbreviation
        // (normalized, so "Ontario" and "ON" match), '' when the player has
        // none (unknown location, or a country with no state-level data);
        // country-level filtering goes through `country` above instead.
        locationKey: stateKeyFor(info.state),
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
    locationSort: [stateKeyFor(info.state) || info.country, info.city].filter(Boolean).join('|').toLowerCase(),
    state: stateKeyFor(info.state),
    country: info.country || 'United States',
    locationKey: stateKeyFor(info.state),
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
  vs: '<path d="M8 2v11"/><path d="M3 5h10"/><path d="M3 5l-1.7 4.2a2 2 0 0 0 3.9 0L3 5z"/><path d="M13 5l-1.7 4.2a2 2 0 0 0 3.9 0L13 5z"/><path d="M6 13h4"/>', // balance-scale glyph — the "compare" affordance (compare tile + per-opponent compare links on player pages)
  // Crossed swords for Rival: two diagonal blades, each with a crossguard
  // near its lower end and a short grip past it.
  rival: '<path d="M3 3l8 8"/><path d="M9.5 12.5l3-3"/><path d="M11 11l2 2"/><path d="M13 3l-8 8"/><path d="M6.5 12.5l-3-3"/><path d="M5 11l-2 2"/>',
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
// A blank date can't be checked against "today", so an event with no date
// is always kept (rather than silently dropped) and sorts after every dated
// event, since there's no way to know if/when it's already passed.
function sortedUpcomingEvents(events) {
  const today = todayIso();
  return events
    .filter((e) => !e.date || e.date >= today)
    .sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return a.date.localeCompare(b.date);
    });
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
    const dateDisplay = e.date ? formatDateHuman(e.date) : 'Date TBA';
    const descriptionHtml = e.description ? `<div class="event-description">${escapeHtml(e.description)}</div>` : '';
    // A card with no link can't be an <a> (an empty/missing href either does
    // nothing or, worse, re-navigates to the current page) -- render it as a
    // plain <div> instead so it's inert rather than a broken link.
    const hasLink = Boolean(e.link);
    const tag = hasLink ? 'a' : 'div';
    const linkAttrs = hasLink ? ` href="${escapeHtml(e.link)}" target="_blank" rel="noopener"` : '';
    // data-date lets client-side JS (setupLiveEventFiltering() in writeJs())
    // re-check this card against the *visitor's* today at page-load time --
    // the server-side filter above only reflects the build machine's today,
    // which goes stale between rebuilds.
    return `<${tag} class="event-card${e.image ? ' has-image' : ''}${hasLink ? '' : ' no-link'}" data-date="${escapeHtml(e.date || '')}"${linkAttrs}${styleAttr}>
  <div class="event-body">
    <div class="event-date">${escapeHtml(dateDisplay)}</div>
    <div class="event-name">${escapeHtml(e.name || 'Future Tournament')}</div>
    ${descriptionHtml}
    ${venueLine ? `<div class="event-venue">${flagImg}${venueLine}</div>` : ''}
  </div>
  ${imageImg}
</${tag}>`;
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

// Derived from team-names.json: resolved player-id-pair -> the nickname the
// team registered under (last entry in file order wins if a pair somehow
// appears twice) -- so a team shows its nickname on cross-tournament
// aggregate views (Doubles tab, player pages) even if a *different*
// tournament had them register as "PlayerA & PlayerB" instead.
const teamDisplayNameByPairKey = new Map();
for (const [nickname, entry] of Object.entries(teamNames)) {
  if (!entry || !Array.isArray(entry.players) || entry.players.length !== 2) continue;
  const [a, b] = entry.players;
  if (!a || !b || !a.id || !b.id) continue;
  teamDisplayNameByPairKey.set(teamKeyFor(a.id, b.id), entry.displayName || nickname);
}

// Canonical text key for a doubles team's raw registration string within a
// given tournament -- prefers the team's registered nickname (unique text,
// since it's the literal string they signed up under) when one exists;
// otherwise falls back to its two resolved players' names joined by " & ".
// Every doubles-aware piece of standings/crosstable/bracket/history code
// MUST go through this (never a bare resolveIdentity call on the raw team
// string) so they all agree on the same key for the same team -- using
// different canonicalizations in different places let a nickname team's
// W-L record and tournament-history entry silently vanish (the raw
// nickname text never matched the joined-names text used elsewhere), and
// let two unrelated teams that are both a pair of anonymous "Unnamed
// Player" placeholders collide onto the same joined-names key.
function teamCanonicalName(rawName, t) {
  const pair = resolveTeamMembers(rawName, t.url);
  if (!pair) return resolveIdentity(rawName, t.url).name;
  const nickname = teamDisplayNameByPairKey.get(teamKeyFor(pair[0].id, pair[1].id));
  return nickname || pair.map((r) => r.name).join(' & ');
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
    const canon = teamCanonicalName(raw, t);
    if (pairByCanonName.has(canon)) return;
    const pair = resolveTeamMembers(raw, t.url);
    if (!pair) return;
    pairByCanonName.set(canon, pair);
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
    if (!teams.has(key)) teams.set(key, { key, players: [a, b], tournaments: new Map(), wins: 0, losses: 0, tournamentWins: 0 });
    return teams.get(key);
  };

  for (const t of allTournaments) {
    if (!t.isDoubles) continue;

    for (const p of t.participantList) {
      const pair = resolveTeamMembers(p.name, t.url);
      if (!pair) continue;
      ensureTeam(pair[0], pair[1]).tournaments.set(t.url, t.label);
    }

    for (const m of t.matches) {
      if (!m.winnerName || !m.loserName) continue;
      const winPair = resolveTeamMembers(m.winnerName, t.url);
      const losePair = resolveTeamMembers(m.loserName, t.url);
      if (!winPair || !losePair) continue;
      const winnerTeam = ensureTeam(winPair[0], winPair[1]);
      winnerTeam.tournaments.set(t.url, t.label);
      winnerTeam.wins += 1;
      const loserTeam = ensureTeam(losePair[0], losePair[1]);
      loserTeam.tournaments.set(t.url, t.label);
      loserTeam.losses += 1;
    }

    // Tournament-win tiebreaker: which team placed 1st in this event.
    const standings = buildStandings(t);
    const pairsByCanonName = resolveDoublesTeamPairs(t);
    for (const s of standings) {
      if (s.rank !== 1) continue;
      const pair = pairsByCanonName.get(s.name);
      if (!pair) continue;
      ensureTeam(pair[0], pair[1]).tournamentWins += 1;
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
    .sort((a, b) => b.wins - a.wins
      || teams.get(b.key).tournamentWins - teams.get(a.key).tournamentWins
      || (b.wins - b.losses) - (a.wins - a.losses));
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
    const nickname = teamDisplayNameByPairKey.get(team.key);
    const teamLabel = nickname ? `<span class="doubles-card-team">${escapeHtml(nickname)}:</span> ` : '';
    const games = team.wins + team.losses;
    const winPct = games > 0 ? Math.round((team.wins / games) * 100) : 0;
    const accent = teamCardAccent(team.players[0], team.players[1]);
    return `<div class="doubles-card ${accent}">
  <div class="doubles-card-names">${teamLabel}${names}</div>
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
    return `<tr${locationDataAttrs(p)}>
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

  // Data behind both CSV-export buttons (see csvDownloadButtonHtml/
  // enableCsvDownloadButtons) -- built independently of the on-page tables
  // rather than scraped from them, so the CSV's column set and sort order
  // (seed-ascending here) can differ from what the visible table shows
  // (alphabetical). Seed is each player's current Power Ranking placement
  // (rankingRows is already sorted by conservativeRating descending, so
  // index+1 is exactly the rank number shown in the PR tab) -- null for
  // players with no ranked games (e.g. doubles-only), who sort after every
  // seeded player, then alphabetically among themselves.
  const rankingById = new Map(rankingRows.map((r, i) => [r.id, { ...r, seed: i + 1 }]));
  const csvPlayerData = [...playerRows]
    .map((p) => {
      const rr = rankingById.get(p.id);
      return {
        seed: rr ? rr.seed : null,
        name: p.name,
        rating: rr ? Math.round(rr.r) : null,
        rd: rr ? Math.round(rr.rd) : null,
        city: p.city,
        state: p.state,
        country: p.country,
        wins: p.wins,
        losses: p.losses,
        games: p.games,
        winPct: p.games > 0 ? +(p.winPct * 100).toFixed(1) : null,
        lastActive: p.lastActive,
        tournamentCount: p.tournaments.length,
      };
    })
    .sort((a, b) => {
      if (a.seed != null && b.seed != null) return a.seed - b.seed;
      if (a.seed != null) return -1;
      if (b.seed != null) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

  // Oldest-to-newest (opposite of the on-page table's newest-first sort) --
  // reads better as a chronological export.
  const csvTournamentData = [...allTournaments]
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.dateOrder || 0) - (b.dateOrder || 0))
    .map((t) => ({
      name: t.label,
      date: t.date,
      venue: t.venue,
      city: t.city,
      state: t.state,
      country: t.country,
      source: t.source,
      participants: t.participants,
      matches: t.matchCount,
      tournamentType: t.isDoubles ? 'Doubles' : 'Singles',
      bracketType: bracketTypeLabel(t) || '',
      bracketUrl: t.url || '',
      videoUrl: tournamentVideos[t.url] || '',
    }));

  const tournamentTableRows = [...allTournaments]
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.dateOrder || 0) - (a.dateOrder || 0))
    .map((t) => `<tr>
      <td><a href="tournaments/${escapeHtml(t.slug)}.html">${escapeHtml(t.label)}</a><a class="ext-link" href="${escapeHtml(t.url)}" target="_blank" rel="noopener" title="View original">&#8599;</a>${t.isDoubles ? ' <span class="doubles-pill">Doubles</span>' : ''}</td>
      <td data-sort="${t.date}">${escapeHtml(t.date)}</td>
      <td>${locationHtml(t.locationDisplay)}</td>
      <td>${escapeHtml(t.source)}</td>
      <td class="numeric" data-sort="${t.isDoubles ? t.participants * 2 : t.participants}">${t.isDoubles ? `${t.participants * 2} (${t.participants})` : t.participants}</td>
      <td class="numeric" data-sort="${t.matchCount}">${t.matchCount}</td>
    </tr>`).join('\n');

  const rankingTableRows = rankingRows.map((p, i) => {
    const nameCell = playerHref(p.id, '') ? `<a href="${escapeHtml(playerHref(p.id, ''))}">${escapeHtml(p.name)}</a>` : escapeHtml(p.name);
    return `<tr data-games="${p.games}" data-rd="${Math.round(p.rd)}"${locationDataAttrs(p)}${p.uncertain ? ' class="uncertain"' : ''}>
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
    return `<div class="pr-card ${cardAccent(p.id, p.color)}${p.uncertain ? ' uncertain' : ''}" data-games="${p.games}" data-rd="${Math.round(p.rd)}"${locationDataAttrs(p)}>
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
  <div class="pr-square-latest-item">${escapeHtml(e.name || 'Future Tournament')} &mdash; ${escapeHtml(e.date ? formatDateHuman(e.date) : 'Date TBA')}</div>
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
${embedMetaTags('DeathBall Power Rankings', 'Glicko-2 power rankings, player stats, and tournament results for the DeathBall community', '')}
<link rel="stylesheet" href="index.css">
<script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
</head>
<body>
<div class="page-title-row">
  <button class="tabs-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false" aria-controls="site-tabs"><svg class="tabs-toggle-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/></svg></button>
  <h1><span id="tab-heading">DeathBall Power Rankings</span></h1>
  <button class="download-btn download-btn-icon" type="button" title="Download power rankings image" aria-label="Download power rankings image">${downloadIconSlotHtml()}</button>
</div>
<div class="tabs" id="site-tabs">
  <button class="tab-button active" data-tab="rankings-tab">Power Rankings</button>
  <button class="tab-button" data-tab="players-tab">Players</button>
  <button class="tab-button" data-tab="tournaments-tab">Tournaments</button>
  <button class="tab-button" data-tab="doubles-tab">Doubles Teams</button>
  <button class="tab-button" data-tab="map-tab">Map</button>
  <button class="tab-button" data-tab="events-tab">Upcoming Events</button>
  <a class="tab-external-link" href="player-graph.html">Connections Graph</a>
  <span class="tab-underline"></span>
</div>
<div class="tabs-backdrop"></div>
<script type="application/json" id="csv-player-data">${JSON.stringify(csvPlayerData)}</script>
<script type="application/json" id="csv-tournament-data">${JSON.stringify(csvTournamentData)}</script>

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
    ${csvDownloadButtonHtml('players', 'deathball-players', false)}
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
  <div class="tab-controls">
    <span id="count">${allTournaments.length} tournaments. Click a column header to sort.</span>
    ${csvDownloadButtonHtml('tournaments', 'deathball-tournaments', false)}
  </div>
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
    <div class="rankings-options-inner">
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
    <button class="download-btn download-btn-boxed" type="button">${downloadIconSlotHtml()}<span class="download-btn-label">Download Top 100</span></button>
    ${csvDownloadButtonHtml('players', 'deathball-players', true)}
    </div>
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
<script type="application/json" id="location-filter-data">${JSON.stringify(buildLocationFilterData())}</script>

${siteFooter('')}
<script src="index.js"></script>
</body>
</html>
`;

  fs.writeFileSync(path.join(REPO_ROOT, 'index.html'), stripCommentsInHeadBlocks(html));
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

// Same underlying score as matchScoreLabel, but kept as the raw {winner,
// loser} pair instead of formatted winner-first -- for a display that
// orients a match to a fixed left/right side rather than assuming the
// winner reads first (see the swiss card layout in writeTournamentPages),
// the two numbers need to land next to whichever side actually earned
// them. Returns null for a DQ (no real score) or a match with no score data.
function matchScoreParts(m) {
  if (m.isDQ) return null;
  if (m.games) {
    const w = m.games.filter((g) => g.winnerGoals > g.loserGoals).length;
    return { winner: w, loser: m.games.length - w };
  }
  if (m.winnerSets != null && m.loserSets != null) return { winner: m.winnerSets, loser: m.loserSets };
  return null;
}

const BRACKETS_VIEWER_HEAD = stripCommentsInHeadBlocks(`<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/brackets-viewer@latest/dist/brackets-viewer.min.css">
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
  /* Doubles brackets show two names per box ("PlayerA & PlayerB") instead
     of one -- the library's default 150px --match-width (with .name's own
     80%-width + ellipsis) truncates a team name far more readily than a
     solo one. 260px is only the ceiling here (see fitDoublesBracketWidth
     below, which shrinks --match-width per tournament down to whatever the
     longest team name in that specific bracket actually needs) -- widened
     only for doubles tournaments (see the .doubles-bracket class added in
     writeTournamentPages) so singles brackets keep their normal, more
     compact box size. */
  .brackets-viewer.doubles-bracket {
    --match-width: 260px;
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

  // 260px (set in CSS above) is only the doubles-bracket ceiling -- shrink
  // --match-width per tournament down to whatever its own longest team name
  // actually needs, so a bracket full of short names doesn't carry the same
  // wide cards as one with long names. .name renders at ~80% of
  // --match-width (see the CSS comment above), so the needed match-width is
  // the widest name's natural text width scaled back up from that 80%.
  // Measured with canvas rather than a DOM clone since it needs each name's
  // own font-weight (a winner's bolded name can be wider than a longer
  // loser's regular-weight one) without a layout round-trip per name.
  function fitDoublesBracketWidth() {
    const measurer = fitDoublesBracketWidth._ctx || (fitDoublesBracketWidth._ctx = document.createElement('canvas').getContext('2d'));
    for (const container of document.querySelectorAll('.brackets-viewer.doubles-bracket')) {
      let maxTextWidth = 0;
      for (const nameEl of container.querySelectorAll('.name')) {
        const cs = getComputedStyle(nameEl);
        measurer.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        const w = measurer.measureText(nameEl.textContent).width;
        if (w > maxTextWidth) maxTextWidth = w;
      }
      if (!maxTextWidth) continue;
      const needed = Math.ceil(maxTextWidth / 0.8) + 8;
      container.style.setProperty('--match-width', Math.min(260, Math.max(150, needed)) + 'px');
    }
  }

  // Box heights can shift once webfonts finish loading; re-run the layout
  // with settled metrics (layoutRounds fully re-derives, so this is safe).
  // Widths are re-fit first since a font swap can change which name is
  // widest, which layoutBrackets' own measurements then need to account for.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { fitDoublesBracketWidth(); layoutBrackets(); });

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
</script>`);

// Always loaded on every tournament page (unlike BRACKETS_VIEWER_HEAD, which
// only loads when a stage actually has a reconstructed bracket) -- wires up
// player hover/click highlighting across the standings list, crosstable
// (round-robin), round-list (swiss and any other non-crosstable stage), and
// bracket viewer alike, since a tournament can have any mix of these stages.
const PLAYER_INTERACTIVITY_HEAD = stripCommentsInHeadBlocks(`<script>
  // Highlights one player everywhere they appear on the page — every
  // bracket match, crosstable row/column, round-list entry (across every
  // stage/container, in case a tournament has more than one), and their
  // standings row — or clears the highlight when called with null. Matched
  // by canonical display name (the same string the standings list,
  // crosstable, round-list, and bracket participants were all rendered
  // with), since bracket participant ids are only unique within their own
  // stage's render, not across the whole page.
  function setActivePlayer(name) {
    for (const el of document.querySelectorAll('.player-active')) el.classList.remove('player-active');
    if (!name) return;
    const li = document.querySelector('.standings-list li[data-player="' + CSS.escape(name) + '"]');
    if (li) li.classList.add('player-active');
    for (const el of document.querySelectorAll('.crosstable [data-player="' + CSS.escape(name) + '"]')) el.classList.add('player-active');
    for (const el of document.querySelectorAll('.crosstable td[data-row-player="' + CSS.escape(name) + '"], .crosstable td[data-col-player="' + CSS.escape(name) + '"]')) el.classList.add('player-active');
    for (const el of document.querySelectorAll('.round-group [data-player="' + CSS.escape(name) + '"]')) el.classList.add('player-active');
    for (const p of document.querySelectorAll('.brackets-viewer .participant[data-participant-id]')) {
      const nameEl = p.querySelector('.name');
      if (!nameEl || nameEl.textContent.trim() !== name) continue;
      p.classList.add('player-active');
    }
  }

  // Wires up: (1) hover/click sync between the standings list, crosstable,
  // round-list, and every bracket on the page via setActivePlayer, with
  // click "pinning" the highlight so it survives the mouse moving away —
  // otherwise there'd be no way to highlight a run and then actually look
  // at it; (2) click-and-drag panning and left/right-arrow scrolling for
  // each bracket container, since a wide bracket only exposes a horizontal
  // scrollbar that's easy to miss. Called once per page, after every stage
  // has rendered.
  function setupPlayerInteractivity() {
    let pinned = null;
    let dragMoved = false; // suppresses the click a drag-release generates

    function playerNameAt(el) {
      const withName = el.closest('[data-player]');
      if (withName) return withName.dataset.player;
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
</script>`);

// Renders a raw in-tournament name as canonical-name-plus-flag markup.
// `opts.noLink` skips the player-page <a> wrapper -- used for match displays
// (crosstable, round-list) where the standings list is meant to be the only
// clickable path to a player's page, same as the brackets-viewer bracket
// (which never links names at all, having no HTML hook to do so).
// `opts.flagAfter` trails the flag after the name instead of leading with
// it -- used for the right-hand side of a swiss card so both cards' flags
// land at the card's outer edges instead of both clustering next to the
// score in the middle.
function nameHtml(rawName, tournamentUrl, opts = {}) {
  if (!rawName) return escapeHtml('?');
  const { id, name, flag } = resolveDisplayName(rawName, tournamentUrl);
  const flagImg = flag ? `<img class="loc-flag" src="${escapeHtml(flag.src)}" title="${escapeHtml(flag.title)}" alt="${escapeHtml(flag.title)}">` : '';
  const href = opts.noLink ? null : playerHref(id, '../');
  const inner = opts.flagAfter ? `${escapeHtml(name)}${flagImg}` : `${flagImg}${escapeHtml(name)}`;
  return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
}

// Doubles-aware counterpart to nameHtml, for tournament pages -- resolves
// the raw team name into its two component players (splitting a separator
// via parseTeamName, or falling back to a team-names.json nickname
// registration -- see resolveTeamMembers) and links each individually
// (clicking either name goes to that player's own page), always joined by
// "&" regardless of what separator the source bracket actually used. Falls
// back to nameHtml itself if neither path resolves two distinct players.
// See nameHtml for `opts.noLink`/`opts.flagAfter`.
function teamNameHtml(rawTeamName, tournamentUrl, opts = {}) {
  const pair = resolveTeamMembers(rawTeamName, tournamentUrl);
  if (!pair) return nameHtml(rawTeamName, tournamentUrl, opts);
  const spans = pair.map(({ id, name }) => {
    const flag = flagForInfo(lookupPlayerInfo(id, name));
    const flagImg = flag ? `<img class="loc-flag" src="${escapeHtml(flag.src)}" title="${escapeHtml(flag.title)}" alt="${escapeHtml(flag.title)}">` : '';
    const href = opts.noLink ? null : playerHref(id, '../');
    const inner = opts.flagAfter ? `${escapeHtml(name)}${flagImg}` : `${flagImg}${escapeHtml(name)}`;
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
      if (!raw) return;
      // Doubles must canonicalize through teamCanonicalName (nickname-
      // preferring) here too, or this map's keys won't match what
      // buildStandings/buildCrosstable produced for `canonicalName`.
      const name = t.isDoubles ? teamCanonicalName(raw, t) : resolveIdentity(raw, t.url).name;
      if (map.has(name)) return;
      map.set(name, raw);
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
    // The standings list is meant to be the only clickable path to a
    // player's page from a tournament page -- the crosstable/round-list
    // (like the brackets-viewer bracket, which never links at all) show
    // plain name+flag markup instead.
    const matchAware = (raw, opts) => (t.isDoubles ? teamNameHtml(raw, t.url, { noLink: true, ...opts }) : nameHtml(raw, t.url, { noLink: true, ...opts }));

    const standingsHtml = standings.length
      ? `<ol class="standings-list">
${standings.map((s) => {
  const raw = rawNameForCanonical(t, s.name);
  const rank = s.rank != null ? s.rank : '—';
  const record = `${s.wins}-${s.losses}`;
  // A doubles team with a registered nickname shows it as a label above
  // the two (still individually clickable) player names, e.g. "Team
  // Ramrod" over "zachaction & Evan" -- see teamCanonicalName.
  const pair = t.isDoubles ? resolveTeamMembers(raw, t.url) : null;
  const nickname = pair ? teamDisplayNameByPairKey.get(teamKeyFor(pair[0].id, pair[1].id)) : null;
  const nameCell = nickname
    ? `<span class="standings-name-stack"><span class="standings-team-name">${escapeHtml(nickname)}</span><span class="standings-team-players">${teamAware(raw)}</span></span>`
    : `<span>${teamAware(raw)}</span>`;
  return `      <li data-player="${escapeHtml(s.name)}"><span class="standings-rank">${rank}</span>${nameCell}<span class="standings-record">${record}</span></li>`;
}).join('\n')}
    </ol>`
      : '<p>No standings available.</p>';

    let usesBracketViewer = false;
    // Raw match winnerName/loserName aren't canonicalized (aliases/splits
    // resolved) the way standings/crosstable names are -- canonicalize here
    // too so a round-list entry's data-player attribute matches the same
    // string the standings list and crosstable use, letting hover/click
    // highlighting sync across all three.
    const canon = (rawName) => resolveIdentity(rawName, t.url).name;
    const stageSections = t.stages.map((stage) => {
      const heading = stage.label ? `<h3 class="stage-label">${escapeHtml(stage.label)}</h3>\n` : '';
      const st = stage.tLike;

      if (stage.bracketData) {
        usesBracketViewer = true;
        const containerId = `bv-${stage.label ? slugify(stage.label) : 'main'}`;
        const { incomplete, participants, ...rest } = stage.bracketData;
        const renderData = { ...rest, participants: participants.map(({ flag, ...p }) => p) };
        // Doubles elimination bracket cards omit flags -- two players' worth
        // of flag + team name is too wide for the bracket's tight card
        // width. Standings/swiss/round-robin doubles views keep flags since
        // they don't share the same width constraint.
        let addFlagsScript = '';
        if (!t.isDoubles) {
          const flagById = {};
          for (const p of participants) if (p.flag) flagById[p.id] = { src: p.flag.src, title: p.flag.title };
          addFlagsScript = `\n  addBracketFlags('#${containerId}', ${JSON.stringify(flagById)});`;
        }
        const note = incomplete ? '<p class="bracket-incomplete-note">&#9888; This bracket was not finished — some matches are missing from the source data, so results past that point aren\'t shown.</p>' : '';
        return `${heading}${note}<div class="brackets-viewer${t.isDoubles ? ' doubles-bracket' : ''}" id="${containerId}"></div>
<script>
  window.bracketsViewer.render(${JSON.stringify(renderData)}, { selector: '#${containerId}' });${addFlagsScript}
  pluralizeBracketNames();
  fitDoublesBracketWidth();
  layoutBrackets();
  markPendingMatches();
</script>`;
      }

      // Round robin plays everyone against everyone, so a dense crosstable
      // reads naturally. Swiss only pairs a handful of opponents per player
      // across a few rounds -- the same crosstable would be mostly empty
      // dots -- so it renders as a round-by-round match list instead (same
      // shape as the elimination round-list below).
      if (st.tournamentType === 'round robin') {
        const stageStandings = stage.label ? buildStandings(st) : standings;
        const { names, cell } = buildCrosstable(st, stageStandings);
        return `${heading}<div class="crosstable-wrap">
  <table class="crosstable">
    <thead><tr><th></th>${names.map((n) => `<th data-player="${escapeHtml(n)}">${matchAware(rawNameForCanonical(t, n))}</th>`).join('')}</tr></thead>
    <tbody>
${names.map((rowName) => `      <tr><th class="row-name" data-player="${escapeHtml(rowName)}">${matchAware(rawNameForCanonical(t, rowName))}</th>${names.map((colName) => {
          const c = cell(rowName, colName);
          const attrs = `data-row-player="${escapeHtml(rowName)}" data-col-player="${escapeHtml(colName)}"`;
          if (c === null) return `<td class="cell-diag" ${attrs}>&mdash;</td>`;
          if (c.empty) return `<td class="cell-empty" ${attrs}>&middot;</td>`;
          const cls = c.label === 'W' ? 'cell-win' : c.label === 'L' ? 'cell-loss' : 'cell-draw';
          return `<td class="${cls}" ${attrs}><span class="crosstable-result ${cls}">${c.label} ${escapeHtml(c.title)}</span></td>`;
        }).join('')}</tr>`).join('\n')}
    </tbody>
  </table>
</div>`;
      }

      const roundGroups = buildRoundGroups(st);
      const isSwiss = st.tournamentType === 'swiss';
      if (!isSwiss) {
        return `${heading}${roundGroups.map((g) => `<div class="round-group">
      <h3>${escapeHtml(g.label)}</h3>
${g.matches.map((m) => `      <div class="match-row"><span class="match-winner" data-player="${escapeHtml(canon(m.winnerName))}">${matchAware(m.winnerName)}</span><span> def. </span><span class="match-loser" data-player="${escapeHtml(canon(m.loserName))}">${matchAware(m.loserName)}</span>${m.isDQ ? '<span class="match-dq">(DQ)</span>' : ''}<span class="match-score">${escapeHtml(matchScoreLabel(m))}</span></div>`).join('\n')}
    </div>`).join('\n')}`;
      }

      // Swiss renders as a grid of cards (3 per row) rather than a stacked
      // list -- a round can have many matches, and a card grid reads faster
      // than a tall column of rows. Left/right side is decided the same way
      // build_bracket.js decides top/bottom for a bracket match slot: a
      // stable hash of the pairing, not who won -- so, like a real bracket,
      // a player isn't pinned to one side just because they won. The score
      // is re-oriented to match: `matchScoreParts` keeps the winner/loser
      // numbers separate so whichever side actually earned a number is the
      // side it's shown on, instead of always printing winner-first.
      return `${heading}${roundGroups.map((g) => `<div class="round-group">
      <h3>${escapeHtml(g.label)}</h3>
      <div class="swiss-round-grid">
${g.matches.map((m) => {
        const key = `${(m.winnerName || '').toLowerCase()}|${(m.loserName || '').toLowerCase()}|${m.groupId ?? ''}:${m.round ?? ''}`;
        const swap = hashStr(key) % 2 === 1;
        const left = swap ? m.loserName : m.winnerName;
        const right = swap ? m.winnerName : m.loserName;
        const leftWon = !swap;
        const parts = matchScoreParts(m);
        let scoreHtml;
        if (m.isDQ) {
          scoreHtml = '<span class="score-dq">DQ</span>';
        } else if (parts) {
          const leftNum = leftWon ? parts.winner : parts.loser;
          const rightNum = leftWon ? parts.loser : parts.winner;
          scoreHtml = `<span class="score-num ${leftWon ? 'score-win' : 'score-loss'}">${leftNum}</span><span class="score-sep">-</span><span class="score-num ${leftWon ? 'score-loss' : 'score-win'}">${rightNum}</span>`;
        } else {
          scoreHtml = '';
        }
        return `      <div class="swiss-match-card"><span class="match-side" data-player="${escapeHtml(canon(left))}">${matchAware(left)}</span><span class="match-score">${scoreHtml}</span><span class="match-side" data-player="${escapeHtml(canon(right))}">${matchAware(right, { flagAfter: true })}</span></div>`;
      }).join('\n')}
      </div>
    </div>`).join('\n')}`;
    }).join('\n');
    const extraHead = PLAYER_INTERACTIVITY_HEAD + (usesBracketViewer ? BRACKETS_VIEWER_HEAD : '');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t.label)} — DeathBall Power Rankings</title>
${embedMetaTags(`${t.label} — DeathBall Tournament`, `Tournament results for ${t.label}. ${[formatDateHuman(t.date), t.locationDisplay.cityState || null].filter(Boolean).join(' — ')}`, `tournaments/${t.slug}.html`)}
<link rel="stylesheet" href="../index.css">
${extraHead}
</head>
<body>
<h1>${escapeHtml(t.label)}</h1>
<div class="tourney-meta">
  <span class="tourney-date">${escapeHtml(formatDateHuman(t.date))}</span>
  ${t.locationDisplay.venue || t.locationDisplay.cityState ? `<span class="tourney-loc">${locationHtml(t.locationDisplay)}</span>` : ''}
  <span class="source-pills">${sourcePillHtml(t.url, t.source)}${tournamentVideos[t.url] ? youtubePillHtml(tournamentVideos[t.url]) : ''}${t.isDoubles ? ' <span class="doubles-pill">Doubles</span>' : ''}</span>
</div>
<a class="back-link" href="../index.html?tab=tournaments">&larr; Back to tournaments</a>

<div class="tourney-columns">
  <div class="tourney-section tourney-standings">
    <h2>Standings</h2>
    ${standingsHtml}
  </div>

  <div class="tourney-section tourney-matches">
    <h2>Matches</h2>
    ${stageSections}
    <script>setupPlayerInteractivity();</script>
  </div>
</div>
${siteFooter('../')}
</body>
</html>
`;

    keep.add(`${t.slug}.html`);
    fs.writeFileSync(path.join(dir, `${t.slug}.html`), stripCommentsInHeadBlocks(html));
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
    <div class="chart-tooltip" data-show="false"></div>
  </div>
</div>`;
}

// Every derived per-player number a player page shows (and the comparison
// page, compare.html, compares) -- computed once here so the two never drift.
// officialRows is the Power-Rankings-qualified subset of rankingRows (5+
// games, RD <= 150), passed in rather than recomputed per player.
function computePlayerProfile(id, p, hist, rankingRows, officialRows, ratingHistory) {
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
  // section (see the branch near the bottom of writePlayerPages' loop); top
  // stat tiles/chart/Match Statistics/match log would all just be empty/zero.
  const isDoublesOnly = p.games === 0;

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

  // Years the player has tournament placements in, collapsed to a single
  // year ("2021") or a range ("2021-2024") for a compact tenure callout
  // shown in the subtitle rather than a stat tile.
  // Years with placements, collapsed into contiguous ranges -- a gap of at
  // least 2 fully inactive years between two active years (year diff >= 3)
  // starts a new comma-separated segment instead of stretching one range
  // across a real absence, e.g. "2019 - 2021, 2025" rather than "2019-2025".
  const activeYearNums = [...new Set(hist.placements.map((pl) => Number((pl.date || '').slice(0, 4))).filter(Boolean))].sort((a, b) => a - b);
  const activeSegments = [];
  for (const year of activeYearNums) {
    const last = activeSegments[activeSegments.length - 1];
    if (last && year - last[1] < 3) last[1] = year;
    else activeSegments.push([year, year]);
  }
  const activeRange = activeSegments
    .map(([start, end]) => (start === end ? `${start}` : `${start} - ${end}`))
    .join(', ');

  // When not qualified, name the specific blocker(s) instead of a blanket
  // "needs 5+ games, RD <= 150" — a player short on RD only shouldn't be
  // told they also need more games when they don't.
  const qualBlockers = [];
  if (officialIdx < 0) {
    if (p.games < 5) qualBlockers.push('5+ games');
    if ((rankingRow ? rankingRow.rd : GLICKO_DEFAULT_RD) > 150) qualBlockers.push('RD ≤ 150');
  }
  const qualNote = qualBlockers.length ? `Needs ${qualBlockers.join(', ')}` : '';

  // Podium/Top 8 rate is a Match Statistics tile -- like the rest of that
  // section, doubles placements don't count toward it (see the isDoubles
  // guards elsewhere in this file), only hist.placements' singles entries.
  const singlesPlacements = hist.placements.filter((pl) => !pl.isDoubles);
  const totalPlacements = singlesPlacements.length;
  const podiumCount = singlesPlacements.filter((pl) => pl.rank <= 3).length;
  const top8Count = singlesPlacements.filter((pl) => pl.rank <= 8).length;

  const peakRating = ratingHistory.length
    ? ratingHistory.reduce((best, h) => (!best || h.rating > best.rating ? h : best), null)
    : null;

  return {
    name, info, flag, location, aliases, isDoublesOnly,
    stocksFor, stocksAgainst, stockDiff, winPct,
    placementsDesc, matchesDesc, h2h,
    rankIdx, rankingRow, officialIdx, bestWin,
    activeRange, qualNote,
    totalPlacements, podiumCount, top8Count,
    peakRating,
  };
}

function writePlayerPages(players, glicko, histories, rankingRows, ratingHistoryById, doublesHistories) {
  const dir = path.join(REPO_ROOT, 'players');
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set();

  const officialRows = rankingRows.filter((r) => r.games >= 5 && r.rd <= 150);

  for (const [id, p] of players.entries()) {
    const slug = playerSlugById.get(id);
    if (!slug) continue;
    const hist = histories.get(id) || { matches: [], placements: [] };
    const ratingHistory = ratingHistoryById.get(id) || [];
    const {
      name, info, flag, location, aliases, isDoublesOnly,
      stocksFor, stocksAgainst, stockDiff, winPct,
      placementsDesc, matchesDesc, h2h,
      rankIdx, rankingRow, officialIdx, bestWin,
      activeRange, qualNote,
      totalPlacements, podiumCount, top8Count,
      peakRating,
    } = computePlayerProfile(id, p, hist, rankingRows, officialRows, ratingHistory);

    const flagImg = flag ? `<img class="loc-flag" src="${escapeHtml(flag.src)}" title="${escapeHtml(flag.title)}" alt="${escapeHtml(flag.title)}">` : '';

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
    // qualNote (from computePlayerProfile) names the specific blocker(s) when
    // the player isn't Power-Rankings-qualified.
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

    // Entry point to the comparison page (compare.html, repo root) with this
    // player pre-selected -- compare.html is deliberately not in the main
    // nav, player pages are the only way in. Sized as a 2-track tile so the
    // row's existing 3+4+6 tiles stay the same relative widths.
    const compareHref = `../compare.html?p=${encodeURIComponent(slug)}`;
    const compareTile = `<a class="stat-tile compare-tile stat-span-2" href="${compareHref}">
  <span class="compare-tile-icon">${h2hIcon('vs')}</span>
  <span class="compare-tile-label">Compare to...</span>
</a>`;

    // Small per-opponent compare affordance pinned to the top-right corner
    // of a Match Statistics tile (see .h2h-compare): opens compare.html with
    // this player and that opponent both pre-selected.
    const compareIconLink = (oppId, oppName) => {
      const oppSlug = playerSlugById.get(oppId);
      if (!oppSlug) return '';
      return `<a class="h2h-compare" href="../compare.html?p=${encodeURIComponent(slug)},${encodeURIComponent(oppSlug)}" title="Compare with ${escapeHtml(oppName)}" aria-label="Compare with ${escapeHtml(oppName)}">${h2hIcon('vs')}</a>`;
    };

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
      return `<div class="h2h-tile">${compareIconLink(entry.opponentId, entry.opponentName)}<span class="h2h-label">${icon}${labelHtml}</span><span class="h2h-value">${opponentLinkHtml(entry.opponentId, entry.opponentName)} <span class="h2h-count">${formatMetric(entry)}</span></span></div>`;
    };
    const bestWinMetric = (e) => {
      const rankLabel = e.oppRank != null ? `#${e.oppRank}` : 'Unranked';
      const spotsLabel = e.spots != null ? (e.spots > 0 ? `+${e.spots}` : `${e.spots}`) : '';
      return `${rankLabel}${spotsLabel ? ` <span class="h2h-record-dim">(${spotsLabel})</span>` : ''}`;
    };
    // For tiles that aren't "vs. an opponent" (streaks, podium rate, rating
    // milestones) — same .h2h-tile shell as h2hRow, just a plain value.
    const statTile = (label, valueHtml, iconKey, flip, mobileLabel) => `<div class="h2h-tile"><span class="h2h-label">${h2hIcon(iconKey, flip)}${dualLabelHtml(label, mobileLabel)}</span><span class="h2h-value">${valueHtml}</span></div>`;

    // Podium/Top 8 rate counts come from computePlayerProfile (singles
    // placements only, like the rest of Match Statistics).
    const rateValue = (count) => totalPlacements
      ? `${count}/${totalPlacements} <span class="h2h-record-dim">(${((count / totalPlacements) * 100).toFixed(0)}%)</span>`
      : '&mdash;';

    // Giant-killer/upset-victim counts show the 150+ tier as the headline
    // number, with the rarer 200+ tier called out alongside it when there
    // are any — a player with zero 200+ wins doesn't need "0 (200+)" noise.
    const gapTierValue = (count, majorCount, showTier = true) => count
      ? `&times;${count}${showTier ? ` <span class="h2h-record-dim">(150+)</span>${majorCount ? ` <span class="h2h-record-dim">&middot; ${majorCount} (200+)</span>` : ''}` : ''}`
      : '&mdash;';

    const h2hSection = `<div class="h2h-grid">
${h2hRow('Best Win Rate (Min. 3)', h2h.bestWinRate, (e) => `${(e.winPct * 100).toFixed(0)}% <span class="h2h-record-dim">(${e.wins}-${e.losses})</span>`, 'trendUp', undefined, 'Best Win Rate')}
${h2hRow('Worst Win Rate (Min. 3)', h2h.worstWinRate, (e) => `${(e.winPct * 100).toFixed(0)}% <span class="h2h-record-dim">(${e.wins}-${e.losses})</span>`, 'trendUp', true, 'Worst Win Rate')}
${h2hRow('Most Wins Against', h2h.mostWinsAgainst, (e) => `&times;${e.wins}`, 'swords', undefined, 'Most Wins Vs')}
${h2hRow('Most Losses Against', h2h.mostLossesAgainst, (e) => `&times;${e.losses}`, 'shield', undefined, 'Most Losses Vs')}
${h2hRow('Most Played', h2h.mostPlayed, (e) => `&times;${e.total}`, 'loop')}
${h2hRow('Rival (Min. 3)', h2h.rival, (e) => `${(e.winPct * 100).toFixed(0)}% <span class="h2h-record-dim">(${e.wins}-${e.losses})</span>`, 'rival', undefined, 'Rival')}
${h2hRow('Best Win', bestWin, bestWinMetric, 'star')}
${statTile('Peak Rating', peakRating ? `<a href="../tournaments/${escapeHtml(peakRating.slug)}.html">${peakRating.rating}</a> <span class="h2h-record-dim">${escapeHtml(formatDateHuman(peakRating.date))}</span>` : '&mdash;', 'mountain')}
${statTile('Longest Win Streak', `${h2h.longestWinStreak}`, 'flame')}
${statTile('Longest Loss Streak', `${h2h.longestLossStreak}`, 'snowflake')}
${statTile('Podium Rate (Top 3)', rateValue(podiumCount), 'podium', undefined, 'Top 3 Rate')}
${statTile('Top 8 Rate', rateValue(top8Count), 'brackets')}
${statTile('Giant Killer Wins', gapTierValue(h2h.giantKiller, h2h.giantKillerMajor), 'breakout')}
${statTile('Upset Victim Losses', gapTierValue(h2h.upsetVictim, h2h.upsetVictimMajor, false), 'breakoutDown', undefined, 'Upset Losses')}
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
      const nickname = teamDisplayNameByPairKey.get(teamKeyFor(id, partner.id));
      const nicknameHtml = nickname ? `<div class="doubles-card-nickname">${escapeHtml(nickname)}</div>` : '';
      const entriesDesc = [...partner.entries].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const entriesHtml = entriesDesc.map((e) => `      <li><span class="standings-rank"><span class="rank-ordinal">${ordinal(e.rank)}<span class="rank-total">/${e.totalEntrants}</span></span> <span class="hist-record">${e.wins}-${e.losses}</span></span><span class="hist-tourney-name"><a href="../tournaments/${escapeHtml(e.slug)}.html">${escapeHtml(e.label)}</a></span><span class="standings-record">${escapeHtml(formatDateHuman(e.date))}</span></li>`).join('\n');
      return `    <div class="doubles-card ${accent}">
${nicknameHtml ? `      ${nicknameHtml}\n` : ''}      <div class="doubles-card-names">${flagImg}${escapeHtml(name)} <span class="doubles-amp">&amp;</span> ${partnerNameHtml}</div>
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
      ? `<div class="aka-content" id="aka-content"><div class="aka-content-inner">AKA: ${aliases.map(escapeHtml).join(', ')}</div></div>`
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
${embedMetaTags(`${name} — DeathBall Player`, isDoublesOnly
      ? ['Profile for ' + name + '.', location || null].filter(Boolean).join(' ')
      : [
          'Profile for ' + name + '.',
          `${p.wins}-${p.losses} (${(winPct * 100).toFixed(1)}%) across ${p.games} game${p.games === 1 ? '' : 's'}.`,
          officialIdx >= 0 ? `Ranked #${officialIdx + 1}.` : null,
          location || null,
        ].filter(Boolean).join(' '), `players/${slug}.html`)}
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
${compareTile}
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
      // Texts-reveal, staggered per row (see .t-stagger-line in writeCss):
      // unhide + mark each row first (transition-delay set per its index in
      // this batch), then flip .is-shown a frame later so the browser has a
      // resting opacity:0 state to transition away from instead of jumping
      // straight to opacity:1.
      hiddenItems.forEach((li, i) => {
        li.hidden = false;
        li.classList.add('t-stagger-line');
        li.style.transitionDelay = (i * 40) + 'ms';
      });
      void list.offsetHeight;
      hiddenItems.forEach((li) => { li.classList.add('is-shown'); });
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
      const wasShown = tooltip.dataset.show === 'true';
      const wrapRect = wrap.getBoundingClientRect();
      const pointRect = point.getBoundingClientRect();
      tooltip.innerHTML = '<strong>' + point.dataset.label + '</strong><br>' +
        point.dataset.date + '<br>Rating ' + point.dataset.rating +
        (point.dataset.rank ? ' &middot; Rank #' + point.dataset.rank : '');
      let left = (pointRect.left - wrapRect.left) + (pointRect.width / 2);
      left = Math.max(60, Math.min(left, wrapRect.width - 60));
      const top = pointRect.top - wrapRect.top;
      // Coming from hidden, snap straight to the new point's position so
      // only the appear (fade+scale) plays -- otherwise it would tween in
      // from wherever it was last shown. Already showing: let left/top
      // transition so the bubble travels to the new point instead of
      // popping there (see the CSS's always-live left/top transition).
      if (!wasShown) {
        tooltip.style.transition = 'none';
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
        void tooltip.offsetWidth;
        tooltip.style.transition = '';
      } else {
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
      }
      tooltip.dataset.show = 'true';
    };
    const hide = () => { tooltip.dataset.show = 'false'; };
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
    fs.writeFileSync(path.join(dir, `${slug}.html`), stripCommentsInHeadBlocks(html));
  }

  cleanStaleHtml(dir, keep);
}

async function main() {
  const challongeTournaments = collectChallonge();
  const startggTournaments = collectStartgg();
  const allTournaments = [...challongeTournaments, ...startggTournaments];

  allTournaments.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.dateOrder || 0) - (b.dateOrder || 0));
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
        //
        // A doubles participant is a whole team string (e.g. "Danny + Rhea")
        // -- resolving it as a single raw player name (as below) never
        // matches any alias/split entry (those are keyed on individual raw
        // player names), so it silently passed through unresolved, showing
        // each team's raw in-tournament spelling in the bracket instead of
        // canonical player names -- inconsistent with every other view of
        // the same tournament (crosstable, standings), which split and
        // resolve each half individually via teamNameHtml/resolveTeamMembers.
        // Do the same split-then-resolve-then-rejoin here.
        for (const p of stage.bracketData.participants) {
          if (t.isDoubles) {
            const pair = resolveTeamMembers(p.name, t.url);
            if (pair) {
              // A team's registered nickname (if any) takes priority over
              // its two players' joined names here -- brackets should read
              // "Team Ramrod", not "zachaction & Evan", when a nickname is
              // on file (see teamCanonicalName).
              const nickname = teamDisplayNameByPairKey.get(teamKeyFor(pair[0].id, pair[1].id));
              p.name = nickname || pair.map((r) => r.name).join(' & ');
              const flags = pair.map((r) => flagForInfo(lookupPlayerInfo(r.id, r.name))).filter(Boolean);
              p.flag = (flags.length === 1 || (flags.length === 2 && flags[0].src === flags[1].src)) ? flags[0] : null;
              continue;
            }
          }
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
      country: meta.country,
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
  //
  // Sourced from `playerRows` (every player, including doubles-only ones
  // with 0 singles games) rather than `rankingRows` (ranked/singles only,
  // per buildRankingRows' games>0 filter) -- a doubles-only player still has
  // a real home location and belongs on the map even though they have no
  // Glicko rating. Their rank/rating/rd are simply left unset (see
  // ratingById below); the map/sidebar render an "Unranked" placeholder for
  // those instead of a numeric rating.
  const rankById = new Map(rankingRows.map((p, i) => [p.id, i + 1]));
  const ratingById = new Map(rankingRows.map((p) => [p.id, { r: p.r, rd: p.rd }]));
  const toMapPlayer = (p) => {
    const rating = ratingById.get(p.id);
    return {
      name: p.name,
      href: playerHref(p.id, ''),
      rank: rankById.get(p.id) ?? null,
      rating: rating ? Math.round(rating.r) : null,
      rd: rating ? Math.round(rating.rd) : null,
      lastActive: p.lastActive,
      flag: p.flag,
    };
  };
  const locatedPlayersAlpha = playerRows
    .filter((p) => p.state || p.country)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const mapAllPlayers = locatedPlayersAlpha.map(toMapPlayer);
  const regionPlayers = new Map();
  for (const p of locatedPlayersAlpha) {
    const abbr = regionAbbr(p.state, p.country);
    if (!abbr) continue;
    if (!regionPlayers.has(abbr)) regionPlayers.set(abbr, []);
    regionPlayers.get(abbr).push(toMapPlayer(p));
  }

  // Tournament dates are pre-formatted human-readable ("May 23, 2026") at
  // generation time — sort by the raw ISO date first, then format, since
  // sorting the formatted strings would order by month name instead of time.
  const toMapTournament = (t) => ({ label: t.label, href: `tournaments/${t.slug}.html`, date: formatDateHuman(t.date), dateIso: t.date, flag: t.locationDisplay.flag });
  const mapAllTournaments = [...allTournaments].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.dateOrder || 0) - (a.dateOrder || 0)).map(toMapTournament);
  const regionTournamentsRaw = new Map();
  for (const t of allTournaments) {
    const abbr = regionAbbr(t.state, t.country);
    if (!abbr) continue;
    if (!regionTournamentsRaw.has(abbr)) regionTournamentsRaw.set(abbr, []);
    regionTournamentsRaw.get(abbr).push(t);
  }
  const regionTournaments = new Map();
  for (const [abbr, list] of regionTournamentsRaw) {
    regionTournaments.set(abbr, [...list].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.dateOrder || 0) - (a.dateOrder || 0)).map(toMapTournament));
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
      name: s.name || STATE_NAMES[s.id] || s.id,
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
  writeJs(GLICKO_UNCERTAIN_RD_THRESHOLD);
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
  resolveTeamMembers,
  cardAccent,
  lookupPlayerInfo,
  flagForInfo,
  STATE_NAMES,
  embedMetaTags,
  escapeHtml,
};
