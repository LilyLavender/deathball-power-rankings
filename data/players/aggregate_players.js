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

const DATA_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(__dirname, '..', '..');

// --- Glicko-2 tuning constants ---
const GLICKO_DEFAULT_R = 1500;
const GLICKO_DEFAULT_RD = 350;
const GLICKO_DEFAULT_SIGMA = 0.06;
const GLICKO_RD_DECAY_PER_MONTH = 5;    // RD added (quadratically) per inactive month
const GLICKO_UNCERTAIN_RD_THRESHOLD = 150; // rows above this RD are dimmed
const GLICKO_CLOSE_GAME_SCORE = 0.86;   // win score for a game won by 1 goal  (3-2)
const GLICKO_NEAR_GAME_SCORE  = 0.94;   // win score for a game won by 2 goals (3-1)
const GLICKO_WITHIN_TOURNAMENT_PASSES = 4; // iterative passes per tournament to correct new-player bias

// State/province abbreviation → full name. If a value isn't found here it is
// passed through as-is (handles cases like "Ontario" already stored in full).
const STATE_NAMES = {
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
};

// Flag image URL helpers
const WIKIMEDIA_FLAG = (file) =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}`;
const NIBSBIN_FLAG = (file) =>
  `https://cdn.jsdelivr.net/gh/nibsbin/us-state-flags-svg@master/flags/${encodeURIComponent(file)}`;
const FLAG_ICON_URL = (code) =>
  `https://cdn.jsdelivr.net/npm/flag-icons@7.5.0/flags/4x3/${code}.svg`;

// City flags — keyed "City|STATE", values are full image URLs (two-hop verified).
// Most are Wikimedia Commons Special:FilePath redirects; Seattle lives on wikipedia/en instead.
const WF = (f) => WIKIMEDIA_FLAG(f); // shorthand
const CITY_FLAGS = {
  'Allen|TX':             WF('Flag_of_Allen,_Texas.svg'),
  'Austin|TX':            WF('Flag_of_Austin,_Texas.svg'),
  'Brandon|MS':           'https://upload.wikimedia.org/wikipedia/commons/8/85/Flag_of_Brandon%2C_Mississippi.png',
  'Chattanooga|TN':       WF('Flag_of_Chattanooga,_Tennessee.svg'),
  'Chicago|IL':           WF('Flag_of_Chicago,_Illinois.svg'),
  'Clawson|MI':           WF('Flag_of_Clawson,_Michigan.svg'),
  'Dallas/Fort Worth|TX': WF('Flag_of_Dallas.svg'),
  'Detroit|MI':           WF('Flag_of_Detroit.svg'),
  'Fort Lauderdale|FL':   WF('Flag_of_Fort_Lauderdale,_Florida.svg'),
  'Grand Island|NE':      'https://upload.wikimedia.org/wikipedia/en/2/2a/GrandIslandNEflag.gif',
  'Grand Rapids|MI':      WF('Flag_of_Grand_Rapids,_Michigan.svg'),
  'Houston|TX':           WF('Flag_of_Houston,_Texas.svg'),
  'Jacksonville|FL':      WF('Flag_of_Jacksonville,_Florida.svg'),
  'Lansing|MI':           'https://upload.wikimedia.org/wikipedia/en/6/65/Flag_of_Lansing%2C_Michigan.svg',
  'Lexington|KY':         'https://upload.wikimedia.org/wikipedia/commons/a/a6/Flag_of_the_Lexington_Fayette_Urban_County_Government.png',
  'Madison|WI':           WF('Flag_of_Madison,_Wisconsin.svg'),
  'Maple Grove|MN':       WF('Flag_of_Maple_Grove,_Minnesota.svg'),
  'Milwaukee|WI':         WF("People's_Flag_of_Milwaukee.svg"),
  'Minneapolis|MN':       WF('Flag_of_Minneapolis.svg'),
  'Orange|CA':            'https://upload.wikimedia.org/wikipedia/commons/f/f3/Flag_of_Orange%2C_California.gif',
  'Portland|OR':          WF('Flag_of_Portland,_Oregon.svg'),
  'Richardson|TX':        WF('Flag_of_Richardson,_Texas.svg'),
  'San Francisco|CA':     WF('Flag_of_San_Francisco.svg'),
  'Seattle|WA':           'https://upload.wikimedia.org/wikipedia/en/6/6d/Flag_of_Seattle.svg',
  'Westminster|CO':       WF('Flag_of_Westminster,_Colorado.svg'),
  'Ypsilanti|MI':         'https://upload.wikimedia.org/wikipedia/en/7/75/Flag_of_Ypsilanti.svg',
};

// US state flags — keyed by abbreviation. Source: nibsbin/us-state-flags-svg via jsDelivr.
const US_STATE_FLAGS = {
  AL: 'Flag_of_Alabama.svg',         AK: 'Flag_of_Alaska.svg',
  AZ: 'Flag_of_Arizona.svg',         AR: 'Flag_of_Arkansas.svg',
  CA: 'Flag_of_California.svg',
  CO: 'Flag_of_Colorado_designed_by_Andrew_Carlisle_Carson.svg',
  CT: 'Flag_of_Connecticut.svg',     DE: 'Flag_of_Delaware.svg',
  FL: 'Flag_of_Florida.svg',         GA: 'Flag_of_Georgia_(U.S._state).svg',
  HI: 'Flag_of_Hawaii.svg',          ID: 'Flag_of_Idaho.svg',
  IL: 'Flag_of_Illinois.svg',        IN: 'Flag_of_Indiana.svg',
  IA: 'Flag_of_Iowa.svg',            KS: 'Flag_of_Kansas.svg',
  KY: 'Flag_of_Kentucky.svg',        LA: 'Flag_of_Louisiana.svg',
  ME: 'Flag_of_Maine.svg',           MD: 'Flag_of_Maryland.svg',
  MA: 'Flag_of_Massachusetts.svg',   MI: 'Flag_of_Michigan.svg',
  MN: 'Flag_of_Minnesota.svg',       MS: 'Flag_of_Mississippi.svg',
  MO: 'Flag_of_Missouri.svg',        MT: 'Flag_of_Montana.svg',
  NE: 'Flag_of_Nebraska.svg',        NV: 'Flag_of_Nevada.svg',
  NH: 'Flag_of_New_Hampshire.svg',   NJ: 'Flag_of_New_Jersey.svg',
  NM: 'Flag_of_New_Mexico.svg',      NY: 'Flag_of_New_York.svg',
  NC: 'Flag_of_North_Carolina.svg',  ND: 'Flag_of_North_Dakota.svg',
  OH: 'Flag_of_Ohio.svg',            OK: 'Flag_of_Oklahoma.svg',
  OR: 'Flag_of_Oregon.svg',          PA: 'Flag_of_Pennsylvania.svg',
  RI: 'Flag_of_Rhode_Island.svg',    SC: 'Flag_of_South_Carolina.svg',
  SD: 'Flag_of_South_Dakota.svg',    TN: 'Flag_of_Tennessee.svg',
  TX: 'Flag_of_Texas.svg',           UT: 'Flag_of_Utah.svg',
  VT: 'Flag_of_Vermont.svg',         VA: 'Flag_of_Virginia.svg',
  WA: 'Flag_of_Washington.svg',      WV: 'Flag_of_West_Virginia.svg',
  WI: 'Flag_of_Wisconsin.svg',       WY: 'Flag_of_Wyoming.svg',
  DC: 'Flag_of_the_District_of_Columbia.svg',
};

// Canadian province flags — keyed by full name (as stored in player-info). Source: Wikimedia Commons.
const CA_PROVINCE_FLAGS = {
  'Alberta':                    'Flag_of_Alberta.svg',
  'British Columbia':           'Flag_of_British_Columbia.svg',
  'Manitoba':                   'Flag_of_Manitoba.svg',
  'New Brunswick':              'Flag_of_New_Brunswick.svg',
  'Newfoundland and Labrador':  'Flag_of_Newfoundland_and_Labrador.svg',
  'Nova Scotia':                'Flag_of_Nova_Scotia.svg',
  'Northwest Territories':      'Flag_of_the_Northwest_Territories.svg',
  'Nunavut':                    'Flag_of_Nunavut.svg',
  'Ontario':                    'Flag_of_Ontario.svg',
  'Prince Edward Island':       'Flag_of_Prince_Edward_Island.svg',
  'Quebec':                     'Flag_of_Quebec.svg',
  'Saskatchewan':               'Flag_of_Saskatchewan.svg',
  'Yukon':                      'Flag_of_Yukon.svg',
};

// Country flags — ISO 3166-1 alpha-2 codes for flag-icons CDN SVGs.
const COUNTRY_CODES = {
  'United States': 'us', 'Canada': 'ca', 'Germany': 'de', 'United Kingdom': 'gb',
  'Australia': 'au', 'France': 'fr', 'Japan': 'jp', 'Mexico': 'mx',
  'Brazil': 'br', 'Netherlands': 'nl', 'Sweden': 'se', 'Norway': 'no',
  'Denmark': 'dk', 'Finland': 'fi', 'Spain': 'es', 'Italy': 'it',
  'Poland': 'pl', 'South Korea': 'kr', 'China': 'cn', 'New Zealand': 'nz',
  'Ireland': 'ie', 'Argentina': 'ar', 'Scotland': 'gb-sct',
};

// Returns { src, title } for an <img> tag, or null if no location info.
function flagForInfo(info) {
  if (!info.city && !info.state && !info.country) return null;
  const country = info.country || 'United States';

  // 1. City flag (values are already full URLs)
  if (info.city && info.state) {
    const url = CITY_FLAGS[`${info.city}|${info.state}`];
    if (url) return { src: url, title: info.city };
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
  const code = COUNTRY_CODES[country];
  if (code) return { src: FLAG_ICON_URL(code), title: country };

  return null;
}

// ---------------------------------

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const identities = readJson(path.join(DATA_ROOT, 'player-identities.json'), { aliases: [], splits: [], hidden: [] });
const hiddenNames = new Set((identities.hidden || []).map((n) => n.trim().toLowerCase()));
const playerInfo = readJson(path.join(DATA_ROOT, 'player-info.json'), { players: {} }).players || {};
const tournamentLocations = readJson(path.join(DATA_ROOT, 'tournament-locations.json'), { locations: {} }).locations || {};

function normName(name) {
  return (name || '').trim();
}

function resolveParticipantName(p) {
  const raw = p.name || p.username || p.display_name || '';
  return raw.replace(/ \(invitation pending\)$/, '');
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

function getPlayer(map, identity) {
  if (!identity || !identity.id) return null;
  const key = identity.id;
  if (!map.has(key)) {
    map.set(key, {
      wins: 0, losses: 0, games: 0,
      tournaments: new Map(),
      nameCounts: new Map(),
    });
  }
  const player = map.get(key);
  player.nameCounts.set(identity.name, (player.nameCounts.get(identity.name) || 0) + 1);
  return player;
}

function displayName(player) {
  return [...player.nameCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function recordMatch(map, winnerRawName, loserRawName, tournamentUrl, tournamentLabel) {
  if (hiddenNames.has(normName(winnerRawName).toLowerCase()) || hiddenNames.has(normName(loserRawName).toLowerCase())) return;
  const winner = getPlayer(map, resolveIdentity(winnerRawName, tournamentUrl));
  const loser = getPlayer(map, resolveIdentity(loserRawName, tournamentUrl));
  if (!winner || !loser) return;
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

function resolveLocation(url, builtIn) {
  const override = tournamentLocations[url];
  return formatLocation(override || builtIn);
}

function resolveDate(url, builtIn) {
  return tournamentLocations[url]?.date || builtIn;
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
    const label = t.name.trim();
    const nameById = new Map(t.participants.map((p) => [p.participant.id, resolveParticipantName(p.participant)]));

    const matches = [];
    for (const m of t.matches) {
      const mm = m.match;
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

      matches.push({ winnerName, loserName, winnerSets, loserSets, games: null, isDQ, identifier: String(mm.identifier || mm.id || '') });
    }

    result.push({
      url,
      label,
      date: resolveDate(url, (t.started_at || t.created_at || '').slice(0, 10)),
      location: resolveLocation(url, null),
      participants: t.participants.length,
      matchCount: matches.length,
      source: 'Challonge',
      matches,
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
    const label = rec.tournament.name.trim();
    const nameByEntrantId = new Map(rec.entrants.map((e) => [e.id, e.participants[0]?.gamerTag]));

    const matches = [];
    for (const s of rec.sets) {
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

      matches.push({ winnerName, loserName, winnerSets, loserSets, games: null, isDQ, identifier: s.identifier || String(s.id || '') });
    }

    result.push({
      url,
      label,
      date: resolveDate(url, rec.tournament.startAt ? new Date(rec.tournament.startAt * 1000).toISOString().slice(0, 10) : ''),
      location: resolveLocation(url, { city: rec.tournament.city, state: rec.tournament.addrState }),
      participants: rec.entrants.length,
      matchCount: matches.length,
      source: 'start.gg',
      matches,
    });
  }

  return result;
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
      winnerSets: null,
      loserSets: null,
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
function processChronologically(allTournaments, players, glicko) {
  for (const tournament of allTournaments) {
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
  }
}

// --- Output builders ---

function buildPlayerRows(players, tournamentLocationByUrl) {
  return [...players.entries()]
    .map(([id, p]) => {
      const name = displayName(p);
      const info = playerInfo[id] || playerInfo[name] || {};
      return {
        name,
        wins: p.wins,
        losses: p.losses,
        games: p.games,
        winPct: p.games > 0 ? p.wins / p.games : 0,
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
          location: tournamentLocationByUrl.get(url) || '',
        })),
      };
    })
    .sort((a, b) => b.winPct - a.winPct || b.games - a.games);
}

function buildRankingRows(players, glicko) {
  return [...players.entries()]
    .map(([id, p]) => {
      const name = displayName(p);
      const info = playerInfo[id] || playerInfo[name] || {};
      const g = glicko.get(id) || { r: GLICKO_DEFAULT_R, rd: GLICKO_DEFAULT_RD, sigma: GLICKO_DEFAULT_SIGMA };
      return {
        id,
        name,
        r: g.r,
        rd: g.rd,
        conservativeRating: glicko2.conservativeRating(g),
        wins: p.wins,
        losses: p.losses,
        games: p.games,
        winPct: p.games > 0 ? p.wins / p.games : 0,
        location: info.city
          ? [info.city, info.state].filter(Boolean).join(', ')
          : info.state
          ? (STATE_NAMES[info.state] || info.state)
          : (info.country || ''),
        flag: flagForInfo(info),
        locationSort: [info.state, info.city].filter(Boolean).join('|').toLowerCase(),
        state: info.state || '',
        color: info.color || '',
        uncertain: Math.round(g.rd) > GLICKO_UNCERTAIN_RD_THRESHOLD,
      };
    })
    .filter((r) => r.games > 0)
    .sort((a, b) => b.conservativeRating - a.conservativeRating);
}

// --- Writers ---

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
body { font-family: 'Rajdhani', system-ui, sans-serif; margin: 0; padding: 1.5rem 2rem; background: #050505; color: #f0f0f0; font-size: 1rem; }
h1 { font-family: 'Press Start 2P', monospace; font-size: 1.1rem; letter-spacing: 0.05em; margin: 0 0 1.5rem; color: #fff; }
a { color: #3eff8b; text-decoration: none; }
a:hover { text-decoration: underline; }
.tabs { display: flex; gap: 0; margin-bottom: 1.5rem; border-bottom: 1px solid #222; }
.tab-button { background: none; border: none; border-bottom: 2px solid transparent; color: #555; font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; padding: 0.6rem 1.2rem; cursor: pointer; margin-bottom: -1px; transition: color 150ms ease, border-color 150ms ease; }
.tab-button:hover { color: #bbb; }
.tab-button.active { color: #3eff8b; border-bottom-color: #3eff8b; }
.tab-panel { display: none; }
.tab-panel.active { display: block; }
.tab-controls { display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
.tab-controls label { color: #888; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; display: flex; align-items: center; gap: 0.5rem; }
.tab-controls select { background: #111; color: #f0f0f0; border: 1px solid #333; border-radius: 2px; padding: 0.3rem 0.6rem; font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 600; transition: border-color 150ms; appearance: none; -webkit-appearance: none; cursor: pointer; }
.tab-controls select:hover { border-color: #555; }
.tab-controls select:focus { outline: none; border-color: #3eff8b; }
.filter-count, .ranking-count { color: #555; font-size: 0.9rem; font-weight: 500; }
#count { color: #555; font-size: 0.9rem; margin-bottom: 1rem; }
.view-toggle { display: flex; gap: 0; background: #111; border: 1px solid #333; border-radius: 3px; padding: 2px; flex-shrink: 0; }
.view-btn { background: none; border: none; color: #555; font-family: 'Rajdhani', sans-serif; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 0.3rem 0.85rem; border-radius: 2px; cursor: pointer; transition: background 150ms, color 150ms; }
.view-btn.active { background: #3eff8b; color: #000; }
.view-btn:not(.active):hover { color: #bbb; }
table { border-collapse: collapse; width: 100%; font-size: 1rem; }
th, td { padding: 0.55rem 0.75rem; border-bottom: 1px solid #1a1a1a; text-align: left; vertical-align: middle; }
th { cursor: pointer; user-select: none; position: sticky; top: 0; background: #111; color: #666; font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; border-bottom: 1px solid #222; }
th:hover { background: #181818; color: #f0f0f0; }
th.no-sort { cursor: default; }
th.no-sort:hover { background: #111; color: #666; }
th.sorted-asc::after { content: " \\25B2"; }
th.sorted-desc::after { content: " \\25BC"; }
tbody tr { transition: background 150ms; }
tbody tr:hover td { background: rgba(62,255,139,0.04); }
tbody tr:hover td:first-child { box-shadow: inset 2px 0 0 #3eff8b; }
.rank-num { font-family: 'Orbitron', monospace; color: #666; text-align: right; min-width: 2rem; font-size: 0.85rem; font-weight: 900; }
.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.col-location { white-space: nowrap; }
.loc-flag { height: 1em; vertical-align: middle; margin-right: 0.35em; border-radius: 1px; }
.uncertain { opacity: 0.45; }
.filter-dim { opacity: 0.45; }
.pr-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 5px; }
.pr-card { background: #0f0f0f; border: 1px solid #222; border-radius: 0; padding: 3px 6px; display: flex; flex-direction: column; gap: 2px; min-width: 0; transition: border-color 150ms, background 150ms; }
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
.prc-top { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-width: 0; }
.prc-top-left { display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1; overflow: hidden; }
.prc-rank { font-family: 'Orbitron', monospace; font-size: 1.2rem; color: #888; font-weight: 900; flex-shrink: 0; line-height: 1; }
.prc-name { font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; font-weight: 700; color: #f0f0f0; overflow: hidden; text-overflow: clip; white-space: nowrap; min-width: 0; }
.prc-flag { height: 0.9em; border-radius: 1px; flex-shrink: 0; }
.prc-stats { display: flex; align-items: baseline; gap: 2px; }
.prc-val { font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 700; color: #aaa; }
.prc-dim { font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 600; color: #444; }
.prc-sep { font-size: 0.75rem; color: #333; font-family: 'Rajdhani', sans-serif; font-weight: 600; margin: 0 1px; }
@media (max-width: 1100px) { .pr-grid { grid-template-columns: repeat(4, 1fr); } }
@media (max-width: 600px) { .pr-grid { grid-template-columns: repeat(2, 1fr); } body { padding: 1rem; } }
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

  function enableTabs() {
    const buttons = [...document.querySelectorAll('.tab-button')];
    const panels = [...document.querySelectorAll('.tab-panel')];
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        panels.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
      });
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

    // Use card grid as count source for rankings (avoids double-counting with table)
    const grid = isRankingsTab ? panel.querySelector('.pr-grid') : null;
    const countSource = grid ? [...grid.children] : (tbody ? [...tbody.rows] : []);

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
      for (const card of grid.children) {
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
          const rankEl = card.querySelector('.prc-rank');
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
      countEl.textContent = visible + ' ' + noun + '. Click a column header to sort.';
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

  function enableViewToggle(panel) {
    const buttons = [...panel.querySelectorAll('.view-btn')];
    if (!buttons.length) return;
    const grid = panel.querySelector('.pr-grid');
    const table = panel.querySelector('table');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.dataset.view;
        if (grid) grid.style.display = view === 'grid' ? '' : 'none';
        if (table) table.style.display = view === 'table' ? '' : 'none';
        if (view === 'grid') fitCardNames(panel);
      });
    });
  }

  function initPanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    populateStateFilter(panel);
    applyFilters(panel);
    panel.querySelectorAll('.min-games-select, .max-rd-select, .state-filter-select').forEach((el) => {
      el.addEventListener('change', () => applyFilters(panel));
    });
    enableViewToggle(panel);
    document.fonts.ready.then(() => fitCardNames(panel));
  }

  document.querySelectorAll('table[data-sortable]').forEach(enableSorting);
  enableTabs();
  initPanel('players-tab');
  initPanel('rankings-tab');
})();
`;
  fs.writeFileSync(path.join(REPO_ROOT, 'index.js'), js);
}

function writeHtml(playerRows, allTournaments, rankingRows) {
  const playerTableRows = playerRows.map((p) => {
    const tournamentLinks = p.tournaments
      .map((t) => `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener"${t.location ? ` title="${escapeHtml(t.location)}"` : ''}>${escapeHtml(t.label)}</a>`)
      .join(', ');
    return `<tr${p.state ? ` data-state="${escapeHtml(p.state)}"` : ''}>
      <td>${escapeHtml(p.name)}</td>
      <td data-sort="${escapeHtml(p.locationSort)}" class="col-location">${p.flag ? `<img class="loc-flag" src="${escapeHtml(p.flag.src)}" title="${escapeHtml(p.flag.title)}" alt="${escapeHtml(p.flag.title)}">` : ''}${escapeHtml(p.location)}</td>
      <td class="numeric" data-sort="${p.wins}">${p.wins}</td>
      <td class="numeric" data-sort="${p.losses}">${p.losses}</td>
      <td class="numeric" data-sort="${p.games}">${p.games}</td>
      <td class="numeric" data-sort="${p.winPct}">${(p.winPct * 100).toFixed(1)}%</td>
      <td class="numeric" data-sort="${p.tournaments.length}">${p.tournaments.length}</td>
      <td>${tournamentLinks}</td>
    </tr>`;
  }).join('\n');

  const tournamentTableRows = [...allTournaments]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map((t) => `<tr>
      <td><a href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.label)}</a></td>
      <td data-sort="${t.date}">${escapeHtml(t.date)}</td>
      <td>${escapeHtml(t.location)}</td>
      <td>${escapeHtml(t.source)}</td>
      <td class="numeric" data-sort="${t.participants}">${t.participants}</td>
      <td class="numeric" data-sort="${t.matchCount}">${t.matchCount}</td>
    </tr>`).join('\n');

  const rankingTableRows = rankingRows.map((p, i) => {
    return `<tr data-games="${p.games}" data-rd="${Math.round(p.rd)}"${p.state ? ` data-state="${escapeHtml(p.state)}"` : ''}${p.uncertain ? ' class="uncertain"' : ''}>
      <td class="rank-num">${i + 1}</td>
      <td>${escapeHtml(p.name)}</td>
      <td class="numeric">${Math.round(p.r)}</td>
      <td class="numeric" data-sort="${p.rd.toFixed(4)}">&#xB1;${Math.round(p.rd)}</td>
      <td class="numeric" data-sort="${p.wins}">${p.wins}</td>
      <td class="numeric" data-sort="${p.losses}">${p.losses}</td>
      <td class="numeric" data-sort="${p.games}">${p.games}</td>
      <td class="numeric" data-sort="${p.winPct}">${(p.winPct * 100).toFixed(1)}%</td>
      <td data-sort="${escapeHtml(p.locationSort)}" class="col-location">${p.flag ? `<img class="loc-flag" src="${escapeHtml(p.flag.src)}" title="${escapeHtml(p.flag.title)}" alt="${escapeHtml(p.flag.title)}">` : ''}${escapeHtml(p.location)}</td>
    </tr>`;
  }).join('\n');

  function cardAccent(name, colorOverride) {
    if (colorOverride === 'green' || colorOverride === 'purple') return `card-${colorOverride}`;
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
    return (h & 1) ? 'card-purple' : 'card-green';
  }

  const rankingCardItems = rankingRows.map((p, i) => {
    const flagImg = p.flag ? `<img class="prc-flag" src="${escapeHtml(p.flag.src)}" title="${escapeHtml(p.flag.title)}" alt="${escapeHtml(p.flag.title)}">` : '';
    return `<div class="pr-card ${cardAccent(p.id, p.color)}${p.uncertain ? ' uncertain' : ''}" data-games="${p.games}" data-rd="${Math.round(p.rd)}"${p.state ? ` data-state="${escapeHtml(p.state)}"` : ''}>
<div class="prc-top">
  <div class="prc-top-left"><span class="prc-rank">${i + 1}</span><span class="prc-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span></div>
  ${flagImg}
</div>
<div class="prc-stats"><span class="prc-val">${Math.round(p.r)}</span><span class="prc-dim">&#xB1;</span><span class="prc-val">${Math.round(p.rd)}</span><span class="prc-sep">|</span><span class="prc-val">${Math.round(p.winPct * 100)}%</span><span class="prc-sep">|</span><span class="prc-val">${p.games}</span><span class="prc-dim">gp</span><span class="prc-sep">|</span><span class="prc-val">${p.wins}</span><span class="prc-dim">-</span><span class="prc-val">${p.losses}</span></div>
</div>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>DeathBall Power Rankings</title>
<link rel="stylesheet" href="index.css">
</head>
<body>
<h1>DeathBall Power Rankings</h1>
<div class="tabs">
  <button class="tab-button active" data-tab="players-tab">Players</button>
  <button class="tab-button" data-tab="tournaments-tab">Tournaments</button>
  <button class="tab-button" data-tab="rankings-tab">Power Rankings</button>
</div>

<div id="players-tab" class="tab-panel active">
  <div class="tab-controls">
    <label>State/Province:
      <select class="state-filter-select">
        <option value="">All locations</option>
      </select>
    </label>
    <span class="filter-count">${playerRows.length} unique players. Click a column header to sort.</span>
  </div>
  <table data-sortable>
    <thead>
      <tr>
        <th data-type="string">Player</th>
        <th data-type="string" data-blank-last="true" class="col-location">Location</th>
        <th data-type="number">Wins</th>
        <th data-type="number">Losses</th>
        <th data-type="number">Games</th>
        <th data-type="number" class="sorted-desc">Win %</th>
        <th data-type="number">Tournaments</th>
        <th data-type="string">Tournament List</th>
      </tr>
    </thead>
    <tbody>
${playerTableRows}
    </tbody>
  </table>
</div>

<div id="tournaments-tab" class="tab-panel">
  <div id="count">${allTournaments.length} tournaments. Click a column header to sort.</div>
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

<div id="rankings-tab" class="tab-panel">
  <div class="tab-controls">
    <div class="view-toggle">
      <button class="view-btn active" data-view="grid">Grid</button>
      <button class="view-btn" data-view="table">Table</button>
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
    <label>State/Province:
      <select class="state-filter-select">
        <option value="">All locations</option>
      </select>
    </label>
    <span class="filter-count"></span>
  </div>
  <div class="pr-grid">
${rankingCardItems}
  </div>
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
        <th data-type="string" data-blank-last="true" class="col-location">Location</th>
      </tr>
    </thead>
    <tbody>
${rankingTableRows}
    </tbody>
  </table>
</div>

<script src="index.js"></script>
</body>
</html>
`;

  fs.writeFileSync(path.join(REPO_ROOT, 'index.html'), html);
}

function main() {
  const challongeTournaments = collectChallonge();
  const startggTournaments = collectStartgg();
  const allTournaments = [...challongeTournaments, ...startggTournaments];

  allTournaments.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const knownUrls = new Set(allTournaments.map((t) => t.url));
  const manualByUrl = loadManualMatches(knownUrls);
  for (const t of allTournaments) {
    const manual = manualByUrl.get(t.url) || [];
    if (manual.length === 0) continue;
    // Manual entries with a match_index replace the scraped match for that slot
    const overrideIds = new Set(manual.map((m) => m.matchIndex).filter(Boolean));
    if (overrideIds.size > 0) {
      t.matches = t.matches.filter((m) => !overrideIds.has(m.identifier));
    }
    t.matches.push(...manual);
  }

  const players = new Map();
  const glicko = new Map();
  processChronologically(allTournaments, players, glicko);

  const tournamentLocationByUrl = new Map(allTournaments.map((t) => [t.url, t.location]));
  const playerRows = buildPlayerRows(players, tournamentLocationByUrl);
  const rankingRows = buildRankingRows(players, glicko);

  writeCsv(playerRows);
  writeCss();
  writeJs();
  writeHtml(playerRows, allTournaments, rankingRows);

  console.log(`Unique players: ${playerRows.length}`);
  console.log(`Tournaments:    ${allTournaments.length}`);
  console.log(`Ranked players: ${rankingRows.length}`);
  console.log(`Output: ${path.join(__dirname, 'players.csv')}`);
  console.log(`Output: ${path.join(REPO_ROOT, 'index.html')}`);
}

main();
