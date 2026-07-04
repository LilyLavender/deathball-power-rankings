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

// --- Glicko-2 tuning constants ---
const GLICKO_DEFAULT_R = 1500;
const GLICKO_DEFAULT_RD = 350;
const GLICKO_DEFAULT_SIGMA = 0.06;
const GLICKO_RD_DECAY_PER_MONTH = 5;    // RD added (quadratically) per inactive month
const GLICKO_UNCERTAIN_RD_THRESHOLD = 150; // rows above this RD are dimmed
const GLICKO_CLOSE_GAME_SCORE = 0.86;   // win score for a game won by 1 goal  (3-2)
const GLICKO_NEAR_GAME_SCORE  = 0.94;   // win score for a game won by 2 goals (3-1)
const GLICKO_WITHIN_TOURNAMENT_PASSES = 4; // iterative passes per tournament to correct new-player bias

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
const tournamentLocations = readJson(path.join(DATA_ROOT, 'tournament-locations.json'), { locations: {} }).locations || {};

function normName(name) {
  return (name || '').trim();
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

// Resolves a raw in-tournament name to its canonical display name plus a
// flag image (if the player has location info on file), for display on
// tournament pages — standings, crosstable, round list, bracket viewer.
function resolveDisplayName(rawName, tournamentUrl) {
  const identity = resolveIdentity(rawName, tournamentUrl);
  const info = lookupPlayerInfo(identity.id, identity.name);
  return { name: identity.name, flag: flagForInfo(info) };
}

// Stats-only pass (no Glicko) — used by add_tournaments.js to build a
// registry of known players for dedup matching against newly fetched names.
function buildPlayerStats(allTournaments) {
  const players = new Map();
  for (const t of allTournaments) {
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

    result.push({
      url,
      label,
      date: resolveDate(url, (t.started_at || t.created_at || '').slice(0, 10)),
      location: resolveLocation(url, null),
      participants: t.participants.length,
      matchCount: matches.length,
      source: 'Challonge',
      tournamentType: t.tournament_type || null,
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
    const label = rec.tournament.name.trim();
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

    result.push({
      url,
      label,
      date: resolveDate(url, rec.tournament.startAt ? new Date(rec.tournament.startAt * 1000).toISOString().slice(0, 10) : ''),
      location: resolveLocation(url, { city: rec.tournament.city, state: rec.tournament.addrState }),
      participants: rec.entrants.length,
      matchCount: matches.length,
      source: 'start.gg',
      tournamentType: null,
      participantList,
      matches,
      pendingMatches,
    });
  }

  return result;
}

function slugify(s) {
  return (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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

function buildPlayerRows(players, tournamentMetaByUrl) {
  return [...players.entries()]
    .map(([id, p]) => {
      const name = displayName(p);
      const info = lookupPlayerInfo(id, name);
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
          location: (tournamentMetaByUrl.get(url) || {}).location || '',
          slug: (tournamentMetaByUrl.get(url) || {}).slug || '',
        })),
      };
    })
    .sort((a, b) => b.winPct - a.winPct || b.games - a.games);
}

function buildRankingRows(players, glicko) {
  return [...players.entries()]
    .map(([id, p]) => {
      const name = displayName(p);
      const info = lookupPlayerInfo(id, name);
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
        locAbbr: abbrevForInfo(info),
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
h1 { font-family: 'Press Start 2P', monospace; font-size: 1.6rem; letter-spacing: 0.05em; margin: 0 0 1.5rem; color: #fff; }
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
.prc-name { font-family: 'Rajdhani', sans-serif; font-size: 0.9rem; line-height: 18px; font-weight: 700; color: #f0f0f0; overflow: hidden; text-overflow: clip; white-space: nowrap; min-width: 0; position: relative; top: 1px; }
.prc-flag { height: 1.15em; border-radius: 2px; flex-shrink: 0; box-shadow: 0 1px 3px rgba(0,0,0,0.6); }
.prc-stats { display: flex; align-items: baseline; gap: 2px; }
.prc-loc-abbr { font-family: 'Rajdhani', sans-serif; font-size: 0.78rem; font-weight: 700; color: #777; letter-spacing: 0.04em; margin-left: auto; padding-left: 4px; flex-shrink: 0; }
.prc-val { font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 700; color: #aaa; }
.prc-dim { font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 600; color: #444; }
.prc-sep { font-size: 0.75rem; color: #333; font-family: 'Rajdhani', sans-serif; font-weight: 600; margin: 0 1px; }
@media (max-width: 1100px) { .pr-grid { grid-template-columns: repeat(4, 1fr); } }
@media (max-width: 600px) { .pr-grid { grid-template-columns: repeat(2, 1fr); } body { padding: 1rem; } }
.back-link { display: inline-block; color: #888; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 1rem; }
.back-link:hover { color: #3eff8b; }
.tourney-meta { display: flex; align-items: center; gap: 1.25rem; color: #888; font-size: 1.05rem; margin: -1rem 0 0.5rem; }
.tourney-meta a { margin: 0; }
.ext-link { font-size: 0.8rem; margin-left: 0.4rem; opacity: 0.7; }
.tourney-section { margin-bottom: 2rem; }
.tourney-section h2 { font-family: 'Rajdhani', sans-serif; font-size: 1rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #3eff8b; border-bottom: 1px solid #222; padding-bottom: 0.4rem; margin-bottom: 0.75rem; }
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
.standings-rank { font-family: 'Orbitron', monospace; color: #666; font-weight: 900; min-width: 2rem; }
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
      .map((t) => `<a href="tournaments/${escapeHtml(t.slug)}.html"${t.location ? ` title="${escapeHtml(t.location)}"` : ''}>${escapeHtml(t.label)}</a>`)
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
      <td><a href="tournaments/${escapeHtml(t.slug)}.html">${escapeHtml(t.label)}</a><a class="ext-link" href="${escapeHtml(t.url)}" target="_blank" rel="noopener" title="View original">&#8599;</a></td>
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

  const rankingCardItems = rankingRows.map((p, i) => {
    const flagImg = p.flag ? `<img class="prc-flag" src="${escapeHtml(p.flag.src)}" title="${escapeHtml(p.flag.title)}" alt="${escapeHtml(p.flag.title)}">` : '';
    const abbrSpan = p.locAbbr ? `<span class="prc-loc-abbr" title="${escapeHtml(p.location)}">${escapeHtml(p.locAbbr)}</span>` : '';
    return `<div class="pr-card ${cardAccent(p.id, p.color)}${p.uncertain ? ' uncertain' : ''}" data-games="${p.games}" data-rd="${Math.round(p.rd)}"${p.state ? ` data-state="${escapeHtml(p.state)}"` : ''}>
<div class="prc-top">
  <div class="prc-top-left"><span class="prc-rank">${i + 1}</span><span class="prc-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span></div>
  ${flagImg}
</div>
<div class="prc-stats"><span class="prc-val">${Math.round(p.r)}</span><span class="prc-dim">&#xB1;</span><span class="prc-val">${Math.round(p.rd)}</span><span class="prc-sep">|</span><span class="prc-val">${Math.round(p.winPct * 100)}</span><span class="prc-dim">W%</span><span class="prc-sep">|</span><span class="prc-val">${p.games}</span><span class="prc-dim">gp</span>${abbrSpan}</div>
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
     bracket, plus their standings row. */
  .brackets-viewer .participant { cursor: pointer; }
  .brackets-viewer .participant.player-active { background-color: rgba(62,255,139,0.18); }
  .brackets-viewer .match.match-player-active .opponents { border-color: rgba(62,255,139,0.7); }
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
    for (const el of document.querySelectorAll('.match-player-active')) el.classList.remove('match-player-active');
    if (!name) return;
    const li = document.querySelector('.standings-list li[data-player="' + CSS.escape(name) + '"]');
    if (li) li.classList.add('player-active');
    for (const p of document.querySelectorAll('.brackets-viewer .participant[data-participant-id]')) {
      const nameEl = p.querySelector('.name');
      if (!nameEl || nameEl.textContent.trim() !== name) continue;
      p.classList.add('player-active');
      const match = p.closest('.match');
      if (match) match.classList.add('match-player-active');
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
  const { name, flag } = resolveDisplayName(rawName, tournamentUrl);
  const flagImg = flag ? `<img class="loc-flag" src="${escapeHtml(flag.src)}" title="${escapeHtml(flag.title)}" alt="${escapeHtml(flag.title)}">` : '';
  return `${flagImg}${escapeHtml(name)}`;
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

function writeTournamentPages(allTournaments) {
  const dir = path.join(REPO_ROOT, 'tournaments');
  fs.mkdirSync(dir, { recursive: true });

  for (const t of allTournaments) {
    const standings = buildStandings(t);

    const standingsHtml = standings.length
      ? `<ol class="standings-list">
${standings.map((s) => `      <li data-player="${escapeHtml(s.name)}"><span class="standings-rank">${s.rank != null ? s.rank : '—'}</span><span>${nameHtml(rawNameForCanonical(t, s.name), t.url)}</span><span class="standings-record">${s.wins}-${s.losses}</span></li>`).join('\n')}
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
    <thead><tr><th></th>${names.map((n) => `<th>${nameHtml(rawNameForCanonical(t, n), t.url)}</th>`).join('')}</tr></thead>
    <tbody>
${names.map((rowName) => `      <tr><th class="row-name">${nameHtml(rawNameForCanonical(t, rowName), t.url)}</th>${names.map((colName) => {
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
${g.matches.map((m) => `      <div class="match-row"><span class="match-winner">${nameHtml(m.winnerName, t.url)}</span><span> def. </span><span class="match-loser">${nameHtml(m.loserName, t.url)}</span>${m.isDQ ? '<span class="match-dq">(DQ)</span>' : ''}<span class="match-score">${escapeHtml(matchScoreLabel(m))}</span></div>`).join('\n')}
    </div>`).join('\n')}`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(t.label)} — DeathBall Power Rankings</title>
<link rel="stylesheet" href="../index.css">
${extraHead}
</head>
<body>
<h1>${escapeHtml(t.label)}</h1>
<div class="tourney-meta">
  <span>${escapeHtml(formatDateHuman(t.date))}</span>
  ${t.location ? `<span>${escapeHtml(t.location)}</span>` : ''}
  <a href="${escapeHtml(t.url)}" target="_blank" rel="noopener">View original on ${escapeHtml(t.source)} &#8599;</a>
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
</body>
</html>
`;

    fs.writeFileSync(path.join(dir, `${t.slug}.html`), html);
  }
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
  processChronologically(allTournaments, players, glicko);

  const tournamentMetaByUrl = new Map(allTournaments.map((t) => [t.url, { location: t.location, slug: t.slug }]));
  const playerRows = buildPlayerRows(players, tournamentMetaByUrl);
  const rankingRows = buildRankingRows(players, glicko);

  writeCsv(playerRows);
  writeCss();
  writeJs();
  writeHtml(playerRows, allTournaments, rankingRows);
  writeTournamentPages(allTournaments);

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
};
