// "Six degrees" player graph. Reads the same tournament stores
// aggregate_players.js reads, builds a nodes/edges graph of "have these two
// players ever played each other," and writes a single self-contained HTML
// file (D3 force layout on a canvas, loaded from jsdelivr) to the repo root.
// Run with:
//   node data/players/player_graph.js
const fs = require('fs');
const path = require('path');
const {
  collectChallonge,
  collectStartgg,
  collectPaper,
  buildPlayerStats,
  resolveIdentity,
  resolveTeamMembers,
  displayName,
  hiddenNames,
  normName,
  cardAccent,
  lookupPlayerInfo,
  flagForInfo,
  STATE_NAMES,
  embedMetaTags,
} = require('./aggregate_players.js');
const { louvain, refineCommunities, computeInternalRatio } = require('./louvain.js');
const { stripCommentsInHeadBlocks } = require('./generate_output.js');

// cardAccent() returns the CSS class the rest of the site uses; resolve it
// to the actual color those classes paint (see .pr-card.card-green/-purple
// in generate_output.js) so nodes match player cards elsewhere on the site.
const ACCENT_HEX = { 'card-green': '#3eff8b', 'card-purple': '#b04fff' };
function accentColor(id, colorOverride) {
  return ACCENT_HEX[cardAccent(id, colorOverride)];
}

function addPairEdge(edgeMap, idA, idB, tournamentUrl) {
  if (idA === idB) return;
  const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
  if (!edgeMap.has(key)) {
    edgeMap.set(key, { source: idA < idB ? idA : idB, target: idA < idB ? idB : idA, weight: 0, tournaments: new Set() });
  }
  const edge = edgeMap.get(key);
  edge.weight += 1;
  edge.tournaments.add(tournamentUrl);
}

function edgesToLinks(edgeMap) {
  return [...edgeMap.values()].map((e) => ({
    source: e.source,
    target: e.target,
    weight: e.weight,
    tournaments: e.tournaments.size,
  }));
}

// Reduces a Map<year, tournamentAttendanceCount> to a single label: one
// dominant year if it covers most of the weight, otherwise the smallest
// span of years that together cover CORE_COVERAGE of it — trimming stray
// outlier years (one member's single trip years earlier) rather than
// letting them stretch a min-max range out wide and uninformatively.
function summarizeYears(yearCounts) {
  const YEAR_MAJORITY = 0.6;
  const CORE_COVERAGE = 0.7;
  const ranked = [...yearCounts.entries()].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((sum, [, c]) => sum + c, 0);
  if (total === 0) return null;
  const [topYear, topCount] = ranked[0];
  if (topCount / total >= YEAR_MAJORITY) return topYear;
  const core = [];
  let cumulative = 0;
  for (const [year, count] of ranked) {
    core.push(year);
    cumulative += count;
    if (cumulative / total >= CORE_COVERAGE) break;
  }
  const sorted = core.sort();
  return sorted.length === 1 ? sorted[0] : `${sorted[0]}–${sorted[sorted.length - 1]}`;
}

// A community's name is derived from its members, in priority order:
//  1. If a majority of members (with location data) share a home region
//     (city, or state when no city is on file), name it after that region.
//  2. If another community in the same mode landed on that same region name
//     (e.g. two separate Dallas/Fort Worth eras), disambiguate both by the
//     years their members' tournaments fall in — a single dominant year
//     ("Dallas/Fort Worth 2021") or a spanning range when it's more spread
//     out ("Dallas/Fort Worth 2021-2022").
//  3. Otherwise (no majority region — a scattered, well-traveled group),
//     name it after the 1-3 tournament venues its members attended most,
//     e.g. "SGDQ / Combo Breaker".
// A region "key" groups by city when known (state alone is too coarse to
// treat as the same place as a city within it), falling back to the state
// — displayed as its full name (STATE_NAMES), never a bare abbreviation.
function regionOf(info) {
  if (!info.city && !info.state) return null;
  if (info.city) return { key: 'city:' + info.city, label: info.city, info };
  return { key: 'state:' + info.state, label: STATE_NAMES[info.state] || info.state, info };
}

// COMMUNITY_MIN_DEGREE (below) correctly excludes a lone bridge player who
// crossed paths with just one person as part of an otherwise well-connected
// community — but it also excludes a player whose entire graph presence is
// one tournament that itself never produced enough internal degree for
// everyone in it (e.g. a small one-off local event where several players'
// only match was a single first-round loss). If EVERY participant of a
// tournament has no games anywhere else, that tournament is a self-contained
// island: reassign all of them to whichever single community (if any)
// Louvain/refineCommunities already gave some of that tournament's more
// active players, or a brand-new community if none of them got one. A
// tournament whose isolated players already disagree on community (more
// than one distinct existing value) is left alone rather than guessed at.
function groupIsolatedTournaments(communityOf, allTournaments, players, nodeIds) {
  let nextId = -1;
  for (const c of communityOf.values()) {
    if (typeof c === 'number' && c > nextId) nextId = c;
  }
  nextId += 1;

  for (const t of allTournaments) {
    const idsInT = new Set();
    for (const p of t.participantList) {
      if (!p.name || hiddenNames.has(normName(p.name).toLowerCase())) continue;
      if (t.isDoubles) {
        const pair = resolveTeamMembers(p.name, t.url);
        if (pair) for (const m of pair) if (nodeIds.has(m.id)) idsInT.add(m.id);
        continue;
      }
      const identity = resolveIdentity(p.name, t.url);
      if (identity && identity.id && nodeIds.has(identity.id)) idsInT.add(identity.id);
    }
    if (idsInT.size < 2) continue;

    let allIsolated = true;
    const existingComms = new Set();
    for (const id of idsInT) {
      const p = players.get(id);
      if (!p || p.tournaments.size !== 1 || !p.tournaments.has(t.url)) { allIsolated = false; break; }
      const c = communityOf.get(id);
      if (c !== null && c !== undefined) existingComms.add(c);
    }
    if (!allIsolated || existingComms.size > 1) continue;

    const target = existingComms.size === 1 ? [...existingComms][0] : nextId++;
    for (const id of idsInT) communityOf.set(id, target);
  }
}

function nameCommunities(members, nodesById, players, tournamentVenueByUrl, tournamentDateByUrl) {
  const REGION_MAJORITY = 0.5;
  const tentative = new Map();
  const regionGroups = new Map();
  const regionMeta = new Map(); // region key -> { label, info } for flag lookup

  for (const [comm, ids] of members.entries()) {
    const regionCounts = new Map();
    let withInfo = 0;
    for (const id of ids) {
      const info = lookupPlayerInfo(id, nodesById.get(id));
      const region = regionOf(info);
      if (!region) continue;
      withInfo += 1;
      regionCounts.set(region.key, (regionCounts.get(region.key) || 0) + 1);
      if (!regionMeta.has(region.key)) regionMeta.set(region.key, { label: region.label, info: region.info });
    }
    let topRegionKey = null, topCount = 0;
    for (const [key, count] of regionCounts.entries()) {
      if (count > topCount) { topCount = count; topRegionKey = key; }
    }
    if (withInfo > 0 && topCount / withInfo >= REGION_MAJORITY) {
      tentative.set(comm, { type: 'region', key: topRegionKey });
      if (!regionGroups.has(topRegionKey)) regionGroups.set(topRegionKey, []);
      regionGroups.get(topRegionKey).push(comm);
      continue;
    }

    const venueCounts = new Map();
    for (const id of ids) {
      const p = players.get(id);
      for (const url of p.tournaments.keys()) {
        const venue = tournamentVenueByUrl.get(url);
        if (!venue) continue;
        venueCounts.set(venue, (venueCounts.get(venue) || 0) + 1);
      }
    }
    const ranked = [...venueCounts.entries()].sort((a, b) => b[1] - a[1]);
    const top = [];
    for (const [venue, count] of ranked) {
      if (top.length === 0 || count >= Math.max(2, ids.length * 0.15)) top.push(venue);
      if (top.length >= 3) break;
    }
    tentative.set(comm, { type: 'venue', label: top.length ? top.join(' / ') : 'Mixed' });
  }

  const finalNames = new Map();
  for (const [comm, info] of tentative.entries()) {
    if (info.type === 'venue') finalNames.set(comm, { label: info.label, flag: null });
  }
  for (const [regionKey, commList] of regionGroups.entries()) {
    const meta = regionMeta.get(regionKey);
    const flag = flagForInfo(meta.info);
    if (commList.length === 1) {
      finalNames.set(commList[0], { label: meta.label, flag });
      continue;
    }
    for (const comm of commList) {
      const yearCounts = new Map();
      for (const id of members.get(comm)) {
        const p = players.get(id);
        for (const url of p.tournaments.keys()) {
          const date = tournamentDateByUrl.get(url);
          if (!date) continue;
          const year = date.slice(0, 4);
          yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
        }
      }
      const years = summarizeYears(yearCounts);
      finalNames.set(comm, { label: years ? `${meta.label} ${years}` : meta.label, flag });
    }
  }
  return finalNames;
}

// Cross-community edge weight, keyed "commA|commB" (lower id first). A
// purely structural, one-time computation from the final community
// assignment — used below to lay communities out relative to each other
// before a single player is placed.
function computeCrossWeights(links, communityOf) {
  const crossWeight = new Map();
  for (const l of links) {
    const ca = communityOf.get(l.source), cb = communityOf.get(l.target);
    if (ca === null || ca === undefined || cb === null || cb === undefined || ca === cb) continue;
    const key = ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
    crossWeight.set(key, (crossWeight.get(key) || 0) + l.weight);
  }
  return crossWeight;
}

// Lays out communities themselves as a handful of "supernodes" — one small,
// separate relaxation, run once here, before a single player is placed —
// so every community gets a fixed anchor point that's structurally
// guaranteed not to overlap any other community's anchor (minimum spacing
// is enforced directly each iteration, not through a force competing
// against other forces). The per-player simulation then just pulls each
// node toward its own community's fixed anchor; since the anchors
// themselves never overlap, neither do the resulting player clouds (given a
// reasonable size estimate below).
//
// This replaces an earlier approach that layered separation/affinity
// forces directly onto the live per-player simulation (713 individually
// jittering nodes) — every fix there meant fighting several competing
// forces at once, with no stable "close but not touching" equilibrium:
// tuning one pair's spacing kept nudging other pairs out of place. Doing
// the spacing once on a dozen fixed supernodes sidesteps that architecture
// problem entirely — non-overlap becomes a property of the layout by
// construction, not something continuously fought for.
function computeCommunityAnchors(sizeOf, crossWeight) {
  const comms = [...sizeOf.keys()];
  const anchors = {};
  if (comms.length === 0) return anchors;

  // A community's radius is estimated from member count alone — real
  // per-player spread isn't known until the client lays individual players
  // out — just needs to be in the right ballpark so anchor spacing roughly
  // matches how much room a community actually ends up needing.
  const radius = new Map(comms.map((c) => [c, 40 + Math.sqrt(sizeOf.get(c)) * 30]));

  // Deterministic starting layout (golden-angle spiral, ordered by id) — no
  // randomness, so regenerating produces the same anchors unless the
  // underlying tournament data actually changed.
  const pos = new Map();
  comms.forEach((c, i) => {
    const angle = i * 2.399963229728653;
    const r = 80 * Math.sqrt(i + 1);
    pos.set(c, { x: r * Math.cos(angle), y: r * Math.sin(angle) });
  });

  const hasConnection = new Set();
  for (const key of crossWeight.keys()) {
    const [ca, cb] = key.split('|').map(Number);
    hasConnection.add(ca);
    hasConnection.add(cb);
  }

  const MARGIN = 40;
  const ITERATIONS = 2000;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    // 1. Pull connected pairs together, but only far enough to just touch
    // (minDist) — never past it, so this never fights the no-overlap
    // constraint in step 3.
    for (const [key, weight] of crossWeight.entries()) {
      const [ca, cb] = key.split('|').map(Number);
      const pa = pos.get(ca), pb = pos.get(cb);
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const minDist = radius.get(ca) + radius.get(cb) + MARGIN;
      const excess = dist - minDist;
      if (excess <= 0) continue;
      const pull = Math.min(weight / 5, 1) * 0.3;
      const step = excess * pull;
      const nx = dx / dist, ny = dy / dist;
      pa.x += nx * step; pa.y += ny * step;
      pb.x -= nx * step; pb.y -= ny * step;
    }
    // 2. Mild gravity toward the overall centroid — stronger for
    // communities with no real ties to anything, so an isolated community
    // (e.g. Madison) still ends up near the main mass rather than drifting
    // wherever its spiral starting point happened to be.
    let cx = 0, cy = 0;
    for (const c of comms) { cx += pos.get(c).x; cy += pos.get(c).y; }
    cx /= comms.length; cy /= comms.length;
    for (const c of comms) {
      const p = pos.get(c);
      const gravity = hasConnection.has(c) ? 0.01 : 0.05;
      p.x += (cx - p.x) * gravity;
      p.y += (cy - p.y) * gravity;
    }
    // 3. Hard minimum-spacing constraint for EVERY pair, connected or not —
    // this is what actually guarantees no two communities' anchors ever end
    // up closer than their combined radius, via direct correction rather
    // than a soft force that step 1's attraction could overpower. Run as
    // several sequential sub-passes, not just one: fixing pair (a, b) can
    // push "a" straight into a violation with "c" that an earlier pass in
    // this same iteration already resolved, so a single pass through every
    // pair doesn't actually guarantee every pair ends up satisfied — this
    // is the standard Gauss-Seidel-style caveat for simultaneous pairwise
    // constraints, and it showed up here as real (if small) residual
    // overlaps between some pairs' final anchors.
    for (let pass = 0; pass < 8; pass++) {
      for (let i = 0; i < comms.length; i++) {
        for (let j = i + 1; j < comms.length; j++) {
          const a = comms[i], b = comms[j];
          const pa = pos.get(a), pb = pos.get(b);
          let dx = pb.x - pa.x, dy = pb.y - pa.y;
          let dist = Math.sqrt(dx * dx + dy * dy);
          const minDist = radius.get(a) + radius.get(b) + MARGIN;
          if (dist < 1e-6) {
            const angle = ((a * 31 + b * 17) % 360) * (Math.PI / 180);
            dx = Math.cos(angle); dy = Math.sin(angle); dist = 1;
          }
          if (dist >= minDist) continue;
          const nx = dx / dist, ny = dy / dist;
          const overlap = (minDist - dist) / 2;
          pa.x -= nx * overlap; pa.y -= ny * overlap;
          pb.x += nx * overlap; pb.y += ny * overlap;
        }
      }
    }
  }

  // Re-center so the anchors' own centroid sits at (0, 0), matching the
  // client simulation's forceCenter/gravity target — otherwise the whole
  // anchor layout could settle off-center and fight those forces every tick.
  let cx = 0, cy = 0;
  for (const c of comms) { cx += pos.get(c).x; cy += pos.get(c).y; }
  cx /= comms.length; cy /= comms.length;
  for (const c of comms) {
    anchors[c] = { x: pos.get(c).x - cx, y: pos.get(c).y - cy, radius: radius.get(c) };
  }
  return anchors;
}

function buildGraph() {
  const challongeTournaments = collectChallonge();
  const startggTournaments = collectStartgg();
  const paperTournaments = collectPaper();
  const allTournaments = [...challongeTournaments, ...startggTournaments, ...paperTournaments];
  const singlesTournaments = allTournaments.filter((t) => !t.isDoubles);
  const doublesTournaments = allTournaments.filter((t) => t.isDoubles);

  // buildPlayerStats only ever looks at singles matches (doubles never
  // touches win/loss/games stats -- same isDoubles guard as the main site's
  // Glicko engine), so a player who only ever played doubles gets no entry
  // here. ensurePlayer backfills a bare 0-games node for them below, same
  // convention aggregate_players.js's registerDoublesParticipants uses so
  // they still show up on the Players tab despite never being ranked.
  const players = buildPlayerStats(singlesTournaments);
  function ensurePlayer(id, name) {
    if (!players.has(id)) {
      players.set(id, { wins: 0, losses: 0, games: 0, tournaments: new Map(), nameCounts: new Map([[name, 1]]), rawNames: new Map() });
    }
    return players.get(id);
  }

  // Register every doubles participant as a node with their real tournament
  // count (from the roster, not just matches -- a team that dropped before
  // playing still entered) before any edges are built, so games=0 nodes
  // still report an accurate tournament count in their tooltip and so
  // groupIsolatedTournaments (which checks p.tournaments) sees them.
  for (const t of doublesTournaments) {
    for (const p of t.participantList) {
      if (!p.name || hiddenNames.has(normName(p.name).toLowerCase())) continue;
      const pair = resolveTeamMembers(p.name, t.url);
      if (!pair) continue;
      for (const m of pair) ensurePlayer(m.id, m.name).tournaments.set(t.url, t.label);
    }
  }

  // "Played against" — an edge per pair who faced off in a real match. For
  // doubles, this expands to two kinds of connection per the site's own
  // request: teammates ("been teamed with") get an edge, and every player
  // on one team gets an edge to every player on the opposing team ("their
  // team has played against") — both are real in-tournament interactions
  // between two specific people, same as a singles head-to-head.
  const playedEdgeMap = new Map();
  for (const t of singlesTournaments) {
    for (const m of t.matches) {
      if (!m.winnerName || !m.loserName) continue;
      if (hiddenNames.has(normName(m.winnerName).toLowerCase())) continue;
      if (hiddenNames.has(normName(m.loserName).toLowerCase())) continue;
      const a = resolveIdentity(m.winnerName, t.url);
      const b = resolveIdentity(m.loserName, t.url);
      if (!a || !b) continue;
      addPairEdge(playedEdgeMap, a.id, b.id, t.url);
    }
  }
  for (const t of doublesTournaments) {
    for (const m of t.matches) {
      if (!m.winnerName || !m.loserName) continue;
      const winPair = resolveTeamMembers(m.winnerName, t.url);
      const losePair = resolveTeamMembers(m.loserName, t.url);
      if (!winPair || !losePair) continue;
      // Doubles matches never touch buildPlayerStats' games/wins/losses
      // (same isDoubles guard the main site's Players tab uses, since
      // doubles isn't part of singles win/loss stats) -- but this graph's
      // node size and tooltip are meant to reflect a player's total match
      // activity, so each side of a doubles match still counts as a game
      // played here, on top of whatever singles games they have.
      for (const p of [...winPair, ...losePair]) ensurePlayer(p.id, p.name).games += 1;
      addPairEdge(playedEdgeMap, winPair[0].id, winPair[1].id, t.url);
      addPairEdge(playedEdgeMap, losePair[0].id, losePair[1].id, t.url);
      for (const w of winPair) for (const l of losePair) addPairEdge(playedEdgeMap, w.id, l.id, t.url);
    }
  }

  // "Attended same tournament" — an edge per pair who both entered the same
  // event, regardless of whether they ever actually played each other.
  // Restricted to players who also appear as a node (i.e. have a recorded
  // match somewhere) — an entrant who never played a single logged match
  // (e.g. dropped before their first match) has no node to draw an edge to.
  // Computed after the doubles pass above so doubles-only players (just
  // registered via ensurePlayer) count as nodes here too.
  const nodeIds = new Set(players.keys());
  const attendedEdgeMap = new Map();
  for (const t of allTournaments) {
    const ids = new Set();
    for (const p of t.participantList) {
      if (!p.name || hiddenNames.has(normName(p.name).toLowerCase())) continue;
      if (t.isDoubles) {
        const pair = resolveTeamMembers(p.name, t.url);
        if (pair) for (const m of pair) if (nodeIds.has(m.id)) ids.add(m.id);
        continue;
      }
      const identity = resolveIdentity(p.name, t.url);
      if (identity && identity.id && nodeIds.has(identity.id)) ids.add(identity.id);
    }
    const idList = [...ids];
    for (let i = 0; i < idList.length; i++) {
      for (let j = i + 1; j < idList.length; j++) {
        addPairEdge(attendedEdgeMap, idList[i], idList[j], t.url);
      }
    }
  }

  const nodes = [...players.entries()].map(([id, p]) => {
    const name = displayName(p);
    const info = lookupPlayerInfo(id, name);
    const flag = flagForInfo(info);
    return {
      id,
      name,
      games: p.games,
      tournaments: p.tournaments.size,
      color: accentColor(id, info.color),
      flag,
    };
  });

  const nodeIdList = nodes.map((n) => n.id);
  const nodesById = new Map(nodes.map((n) => [n.id, n.name]));
  const playedLinks = edgesToLinks(playedEdgeMap);
  const attendedLinks = edgesToLinks(attendedEdgeMap);
  // Nodes whose own community accounts for under half their edge weight
  // (weak bridges, one-off cross-community matches), or who've only ever
  // crossed paths with a single other person, are left communityless (null)
  // rather than forced into a group they barely belong to.
  const COMMUNITY_THRESHOLD = 0.5;
  const COMMUNITY_MIN_DEGREE = 2;
  const playedCommunity = refineCommunities(nodeIdList, playedLinks, louvain(nodeIdList, playedLinks), COMMUNITY_THRESHOLD, COMMUNITY_MIN_DEGREE);
  const attendedCommunity = refineCommunities(nodeIdList, attendedLinks, louvain(nodeIdList, attendedLinks), COMMUNITY_THRESHOLD, COMMUNITY_MIN_DEGREE);
  groupIsolatedTournaments(playedCommunity, allTournaments, players, nodeIds);
  groupIsolatedTournaments(attendedCommunity, allTournaments, players, nodeIds);
  // Which members are "core" enough to a community to help shape its
  // visual hull, computed once here from graph topology (not from live
  // simulated x/y) — recomputed against the FINAL community assignments
  // (after groupIsolatedTournaments), same ratio refineCommunities uses
  // internally, just at a stricter cutoff. Baking this into the served data
  // means the browser's hull outline is built from a fixed member set that
  // never changes tick to tick, instead of a live position-based trim that
  // can flicker as a borderline member's simulated position jitters in and
  // out of "outlier" range.
  const HULL_CORE_THRESHOLD = 0.6;
  const playedRatio = computeInternalRatio(nodeIdList, playedLinks, playedCommunity);
  const attendedRatio = computeInternalRatio(nodeIdList, attendedLinks, attendedCommunity);
  for (const n of nodes) {
    n.communityPlayed = playedCommunity.get(n.id);
    n.communityAttended = attendedCommunity.get(n.id);
    const pr = playedRatio.get(n.id);
    const ar = attendedRatio.get(n.id);
    n.hullCorePlayed = pr === null || pr === undefined ? true : pr >= HULL_CORE_THRESHOLD;
    n.hullCoreAttended = ar === null || ar === undefined ? true : ar >= HULL_CORE_THRESHOLD;
  }

  const tournamentVenueByUrl = new Map(allTournaments.map((t) => [t.url, t.venue || t.city || null]));
  const tournamentDateByUrl = new Map(allTournaments.map((t) => [t.url, t.date || null]));
  function membersOf(communityMap) {
    const members = new Map();
    for (const [id, comm] of communityMap.entries()) {
      if (comm === null || comm === undefined) continue;
      if (!members.has(comm)) members.set(comm, []);
      members.get(comm).push(id);
    }
    // Only communities that actually get a rendered background (2+ members)
    // need a name.
    for (const [comm, ids] of [...members.entries()]) {
      if (ids.length < 2) members.delete(comm);
    }
    return members;
  }
  const playedNames = nameCommunities(membersOf(playedCommunity), nodesById, players, tournamentVenueByUrl, tournamentDateByUrl);
  const attendedNames = nameCommunities(membersOf(attendedCommunity), nodesById, players, tournamentVenueByUrl, tournamentDateByUrl);

  const playedSizeOf = new Map();
  const attendedSizeOf = new Map();
  for (const n of nodes) {
    if (n.communityPlayed !== null && n.communityPlayed !== undefined) {
      playedSizeOf.set(n.communityPlayed, (playedSizeOf.get(n.communityPlayed) || 0) + 1);
    }
    if (n.communityAttended !== null && n.communityAttended !== undefined) {
      attendedSizeOf.set(n.communityAttended, (attendedSizeOf.get(n.communityAttended) || 0) + 1);
    }
  }
  const playedAnchors = computeCommunityAnchors(playedSizeOf, computeCrossWeights(playedLinks, playedCommunity));
  const attendedAnchors = computeCommunityAnchors(attendedSizeOf, computeCrossWeights(attendedLinks, attendedCommunity));

  return {
    nodes,
    played: playedLinks,
    attended: attendedLinks,
    communityNames: {
      played: Object.fromEntries(playedNames),
      attended: Object.fromEntries(attendedNames),
    },
    communityAnchors: {
      played: playedAnchors,
      attended: attendedAnchors,
    },
  };
}

function writePage(graph) {
  const dataJson = JSON.stringify(graph);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeathBall Player Connections</title>
${embedMetaTags('DeathBall Player Connections', 'An interactive graph of who has played who across DeathBall tournaments', 'player-graph.html')}
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
  html, body { margin: 0; padding: 0; background: #050505; color: #f0f0f0; font-family: 'Rajdhani', system-ui, sans-serif; overflow: hidden; height: 100%; }
  @font-face { font-family: 'Rajdhani'; src: local('Rajdhani'); }
  #graph-canvas { display: block; cursor: grab; }
  #graph-canvas.dragging { cursor: grabbing; }
  .hud { position: fixed; top: 1.5rem; left: 2rem; z-index: 2; display: flex; flex-direction: column; gap: 0.6rem; max-width: 280px; }
  .back-link { display: inline-block; color: #888; font-size: 0.85rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; text-decoration: none; }
  .back-link:hover { color: #3eff8b; text-decoration: underline; }
  .hud-title { font-family: 'Press Start 2P', monospace; font-size: 1.6rem; letter-spacing: 0.05em; margin: 0; color: #fff; white-space: nowrap; }
  .hud-sub { font-size: 0.8rem; color: #888; letter-spacing: 0.02em; }
  .hud input[type="text"] { background: #111; border: 1px solid #333; border-radius: 3px; color: #f0f0f0; font-family: inherit; font-size: 0.95rem; padding: 0.45rem 0.7rem; width: 100%; box-sizing: border-box; }
  .hud input[type="text"]:focus { outline: none; border-color: #3eff8b; }
  .hud-stat { font-size: 0.75rem; color: #666; }
  .search-wrap { position: relative; }
  .autocomplete-list { position: absolute; top: 100%; left: 0; right: 0; margin-top: 3px; background: #111; border: 1px solid #333; border-radius: 3px; max-height: 180px; overflow-y: auto; z-index: 5; display: none; }
  .autocomplete-list.visible { display: block; }
  .autocomplete-item { padding: 0.4rem 0.7rem; font-size: 0.85rem; color: #ddd; cursor: pointer; }
  .autocomplete-item:hover { background: #222; color: #3eff8b; }
  .separation-box { display: flex; flex-direction: column; gap: 0.4rem; }
  .separation-label { font-size: 0.75rem; color: #888; letter-spacing: 0.03em; text-transform: uppercase; }
  .separation-output { font-size: 0.8rem; color: #ccc; line-height: 1.5; }
  .separation-output .sep-degrees { color: #3eff8b; font-weight: 700; }
  .mode-toggle { display: flex; gap: 0; background: #111; border: 1px solid #333; border-radius: 3px; padding: 2px; }
  .mode-btn { flex: 1; background: none; border: none; color: #888; font-family: inherit; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; padding: 0.4rem 0.5rem; border-radius: 2px; cursor: pointer; transition: color 150ms, background 150ms; }
  .mode-btn.active { background: #3eff8b; color: #050505; }
  .groups-toggle { display: flex; gap: 0; background: #111; border: 1px solid #333; border-radius: 3px; padding: 2px; flex-shrink: 0; align-self: flex-start; }
  .groups-btn { background: none; border: none; color: #888; font-family: inherit; font-size: 0.7rem; font-weight: 700; letter-spacing: 0; text-transform: uppercase; padding: 0.4rem 0.6rem; border-radius: 2px; cursor: pointer; transition: color 150ms, background 150ms; }
  .groups-btn.active { background: #3eff8b; color: #050505; }
  .tooltip { position: fixed; pointer-events: none; z-index: 3; background: #111; border: 1px solid #333; border-radius: 3px; padding: 0.5rem 0.75rem; font-size: 0.85rem; line-height: 1.5; color: #ddd; display: none; max-width: 240px; box-shadow: 0 4px 16px rgba(0,0,0,0.5); }
  .tooltip .t-name { display: flex; align-items: center; font-weight: 700; font-size: 1rem; color: #fff; margin-bottom: 0.15rem; }
  .tooltip .t-flag { height: 1em; vertical-align: middle; margin-right: 0.35em; border-radius: 1px; }
  .tooltip .t-stat { color: #999; }
</style>
</head>
<body>
<div class="hud">
  <h1 class="hud-title">Player Connections</h1>
  <a class="back-link" href="index.html">&larr; Back to rankings</a>
  <div class="hud-sub">All players connected by shared history</div>
  <div class="search-wrap">
    <input type="text" id="search" placeholder="Find a player..." autocomplete="off">
    <div class="autocomplete-list" id="search-list"></div>
  </div>
  <div class="mode-toggle">
    <button type="button" class="mode-btn active" id="mode-played">Played Against</button>
    <button type="button" class="mode-btn" id="mode-attended">Attended Same Tournament</button>
  </div>
  <div class="groups-toggle">
    <button type="button" class="groups-btn active" id="groups-on">Show Groups</button>
    <button type="button" class="groups-btn" id="groups-off">Hide Groups</button>
  </div>
  <div class="separation-box">
    <div class="separation-label">Degrees of Separation</div>
    <div class="search-wrap">
      <input type="text" id="separation-input" placeholder="Compare with..." autocomplete="off">
      <div class="autocomplete-list" id="separation-list"></div>
    </div>
    <div class="separation-output" id="separation-output"></div>
  </div>
  <div class="hud-stat" id="graph-stat"></div>
</div>
<div class="tooltip" id="tooltip"></div>
<canvas id="graph-canvas"></canvas>
<script>
const GRAPH = ${dataJson};
(function () {
  const canvas = document.getElementById('graph-canvas');
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');

  // Flag images are loaded lazily (canvas can't just point at a <img> src
  // like the rest of the site does) and cached by URL; a hull whose flag
  // isn't loaded yet just renders without one until the load triggers a
  // redraw.
  const flagImageCache = new Map();
  function getFlagImage(url) {
    let entry = flagImageCache.get(url);
    if (!entry) {
      const img = new Image();
      entry = { img, ready: false };
      img.onload = () => { entry.ready = true; draw(); };
      img.src = url;
      flagImageCache.set(url, entry);
    }
    return entry.ready ? entry.img : null;
  }
  const searchInput = document.getElementById('search');
  const searchList = document.getElementById('search-list');
  const separationInput = document.getElementById('separation-input');
  const separationList = document.getElementById('separation-list');
  const separationOutput = document.getElementById('separation-output');
  const modePlayedBtn = document.getElementById('mode-played');
  const modeAttendedBtn = document.getElementById('mode-attended');
  const groupsOnBtn = document.getElementById('groups-on');
  const groupsOffBtn = document.getElementById('groups-off');
  const graphStat = document.getElementById('graph-stat');
  // Groups stay on by default; this only hides the hull/label overlay drawn
  // in draw() — it doesn't touch the community anchor forces, so toggling
  // it doesn't reshuffle anyone's position.
  let showGroups = true;
  function setShowGroups(value) {
    showGroups = value;
    groupsOnBtn.classList.toggle('active', value);
    groupsOffBtn.classList.toggle('active', !value);
    draw();
  }
  groupsOnBtn.addEventListener('click', () => setShowGroups(true));
  groupsOffBtn.addEventListener('click', () => setShowGroups(false));

  let width, height, dpr;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
  }
  resize();
  window.addEventListener('resize', () => { resize(); draw(); });

  const radiusScale = d3.scaleSqrt().domain([1, d3.max(GRAPH.nodes, (n) => n.games) || 1]).range([6, 40]);
  const widthScale = d3.scaleLinear();
  const HULL_LABEL_FONT_WORLD = 28;

  let currentMode = 'played';
  // A doubles-only player has 0 singles games (buildPlayerStats never sees
  // doubles matches) -- floor at 1 so they still render at the scale's
  // minimum node size instead of extrapolating below it.
  let nodes = GRAPH.nodes.map((n) => ({ ...n, r: radiusScale(n.games || 1) }));
  let links = [];

  // Auto-detected community backgrounds — a translucent blob behind each
  // Louvain-detected cluster of players, distinct per mode (see louvain.js).
  // Golden-angle hue spacing gives well-separated colors regardless of how
  // many communities a given mode turns up.
  function communityField() { return currentMode === 'played' ? 'communityPlayed' : 'communityAttended'; }
  function hullCoreField() { return currentMode === 'played' ? 'hullCorePlayed' : 'hullCoreAttended'; }
  function communityColor(comm) { return 'hsl(' + ((comm * 137.508) % 360) + ', 65%, 55%)'; }
  function communityNames() { return currentMode === 'played' ? GRAPH.communityNames.played : GRAPH.communityNames.attended; }

  const hullLine = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5));
  let hulls = [];
  function updateHulls() {
    const field = communityField();
    const coreField = hullCoreField();
    const names = communityNames();
    const byComm = new Map();
    for (const n of nodes) {
      if (n.x === undefined) continue;
      const c = n[field];
      if (c === null || c === undefined) continue; // not strongly enough affiliated with any group
      if (!byComm.has(c)) byComm.set(c, []);
      byComm.get(c).push(n);
    }
    const next = [];
    for (const [comm, allMembers] of byComm.entries()) {
      if (allMembers.length < 2) continue;
      // A handful of loosely-tied members (weak internal edge weight, per
      // hullCorePlayed/hullCoreAttended — computed once server-side from
      // graph topology, see aggregate/player_graph.js) can stretch a
      // community's convex hull into a long, spiky sliver instead of a
      // readable blob. Filtering them out here uses a fixed, precomputed
      // flag rather than each member's live simulated position, so the set
      // of points shaping the hull never changes tick to tick — a
      // position-based trim used earlier caused visible flicker as a
      // borderline member's jittering position toggled it in and out of the
      // trimmed set. Falls back to every member if the core set gets too
      // small to shape a meaningful hull.
      const core = allMembers.filter((n) => n[coreField]);
      const members = core.length >= 2 ? core : allMembers;
      const points = [];
      for (const n of members) {
        const pad = n.r + 16;
        for (let a = 0; a < 8; a++) {
          const t = (a / 8) * Math.PI * 2;
          points.push([n.x + Math.cos(t) * pad, n.y + Math.sin(t) * pad]);
        }
      }
      const hull = d3.polygonHull(points);
      if (!hull) continue;
      let minX = Infinity, maxX = -Infinity, minY = Infinity;
      for (const [px, py] of hull) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
      }
      const info = names[comm];
      next.push({
        comm,
        hull,
        color: communityColor(comm),
        label: info ? info.label : null,
        flag: info ? info.flag : null,
        labelX: (minX + maxX) / 2,
        labelY: minY - 14,
      });
    }
    hulls = next;
  }

  // A communityless node (too weakly tied to any one group to count as a
  // real member — see refineCommunities in louvain.js) still often has a
  // real link to a specific community member. With nothing containing it,
  // charge/gravity alone can leave it stranded far from that one connection
  // — visually a long trail stretching from a community's edge out to an
  // isolated dot in open space. This computes, once per mode switch (it's
  // pure graph topology, not live position, so it doesn't need recomputing
  // every tick), which single community each communityless node is most
  // strongly tied to — used below to give it a loose "honorary member"
  // leash toward that community, without actually making it a member (no
  // effect on its color, hull membership, or the Louvain assignment itself).
  let communitylessAffinity = new Map();
  function updateCommunitylessAffinity() {
    const field = communityField();
    const weightByNeighborComm = new Map(); // communityless node id -> Map(commId -> weight)
    function record(looseNode, tiedComm, weight) {
      let m = weightByNeighborComm.get(looseNode.id);
      if (!m) { m = new Map(); weightByNeighborComm.set(looseNode.id, m); }
      m.set(tiedComm, (m.get(tiedComm) || 0) + weight);
    }
    for (const l of links) {
      const sc = l.source[field], tc = l.target[field];
      const sLoose = sc === null || sc === undefined;
      const tLoose = tc === null || tc === undefined;
      if (sLoose && !tLoose) record(l.source, tc, l.weight);
      else if (tLoose && !sLoose) record(l.target, sc, l.weight);
    }
    communitylessAffinity = new Map();
    for (const [id, m] of weightByNeighborComm.entries()) {
      let bestComm = null, bestWeight = 0;
      for (const [comm, weight] of m.entries()) {
        if (weight > bestWeight) { bestWeight = weight; bestComm = comm; }
      }
      communitylessAffinity.set(id, bestComm);
    }
  }

  // Every community's fixed anchor point was already computed server-side
  // (see computeCommunityAnchors in aggregate/player_graph.js), laid out
  // there specifically so no two communities' anchors can end up closer
  // than their combined estimated size — non-overlap is a property of that
  // layout by construction, not something fought for continuously here.
  //
  // A first version pulled every member directly toward that single fixed
  // point (d3.forceX/forceY with a constant target), which is the wrong
  // tool: pulling a whole community toward one exact coordinate makes it
  // clump into a tight, unnaturally perfect circle regardless of its real
  // connection structure, since the pull never lets up even for members
  // already comfortably inside their own community's space. This version is
  // a containment (leash), not an attraction — zero force on a member
  // sitting anywhere within its community's allocated radius, only pulling
  // back in once a member strays past that boundary. Internal shape (how
  // members actually distribute within that space — tight, elongated,
  // branching) is left entirely to the ordinary link/charge/collide forces.
  //
  // A communityless node with a real tie to one community (communitylessAffinity)
  // gets the same treatment, just with a looser leash — it's not actually a
  // member, so it's allowed to sit a bit past the community's own edge
  // rather than being pulled fully inside, but it's still kept from
  // trailing off indefinitely into open space. A communityless node with no
  // real tie to anything is left completely free, same as before.
  function forceCommunityContainment(strength) {
    let nodesRef;
    function force(alpha) {
      const field = communityField();
      const anchors = GRAPH.communityAnchors[currentMode];
      for (const n of nodesRef) {
        const ownComm = n[field];
        const isMember = ownComm !== null && ownComm !== undefined;
        const c = isMember ? ownComm : communitylessAffinity.get(n.id);
        if (c === null || c === undefined) continue;
        const anchor = anchors[c];
        if (!anchor) continue;
        const dx = n.x - anchor.x, dy = n.y - anchor.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const limit = anchor.radius * (isMember ? 0.85 : 1.15);
        if (dist <= limit) continue;
        const excess = dist - limit;
        const nx = dist > 1e-6 ? dx / dist : 0, ny = dist > 1e-6 ? dy / dist : 0;
        const pull = excess * strength * alpha;
        n.vx -= nx * pull;
        n.vy -= ny * pull;
      }
    }
    force.initialize = (ns) => { nodesRef = ns; };
    return force;
  }

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink().id((d) => d.id).distance(50).strength(0.12))
    .force('charge', d3.forceManyBody().strength(-90))
    .force('center', d3.forceCenter(0, 0))
    // forceCenter only rigidly re-centers the mean position — it doesn't
    // compress how far charge repulsion has spread everyone out, which is
    // why a lopsided/sparse layout (mass bunched on one side, empty canvas
    // elsewhere) stays lopsided even though it's technically centered. A
    // weak forceX/forceY toward the origin acts like gravity: every node
    // gets pulled inward proportional to its own distance from center, so
    // the whole mass compacts into a tighter, more evenly filled shape
    // instead of just sitting whichever lopsided way charge happened to
    // push it. Kept weak on purpose — mainly relevant to communityless
    // nodes now, since community members are already anchored below.
    .force('gravityX', d3.forceX(0).strength(0.035))
    .force('gravityY', d3.forceY(0).strength(0.035))
    .force('collide', d3.forceCollide((d) => d.r + 2))
    .force('communityContainment', forceCommunityContainment(0.4))
    .alphaDecay(0.02)
    .on('tick', () => { updateHulls(); draw(); if (autoFit) fitToView(); });

  let hoverNode = null;
  // While a search match is active: the matched player stays at normal
  // brightness, their 1st-degree connections (darkenIds) render slightly
  // darker (same hue, just dimmer), and everyone else fades to very dull —
  // that three-way contrast is what makes the match and its immediate
  // circle stand out from the rest of the graph. Both null when no search
  // is active (or it matched no one), leaving everyone at normal brightness.
  let matchedId = null;
  let darkenIds = null;
  // The degrees-of-separation path (array of node ids, endpoints included),
  // and the same path as a Set of directed "a|b" edge keys for O(1) lookup
  // while drawing links — both null when no valid comparison is active.
  // Path nodes/edges render as an explicit bright route on top of the
  // normal match/neighbor/dull tiers, so the connection is visible on the
  // graph itself, not just spelled out as a list of names in the sidebar.
  let separationPath = null;
  let separationEdgeKeys = null;
  let dragging = null;
  // Keeps the view zoomed/panned to frame the whole graph while the force
  // simulation is still spreading nodes out — turned off the moment the user
  // takes over panning/zooming themselves, so it never fights their input.
  let autoFit = true;

  let transform = d3.zoomIdentity.translate(width / 2, height / 2);
  const zoom = d3.zoom()
    .scaleExtent([0.05, 8])
    // Let a mousedown that lands on a node start a node-drag (handled below)
    // instead of a canvas pan — only mousedowns on empty space pan.
    .filter((event) => {
      if (event.type !== 'mousedown') return true;
      const rect = canvas.getBoundingClientRect();
      return !nodeAt(event.clientX - rect.left, event.clientY - rect.top);
    })
    .on('zoom', (event) => {
      transform = event.transform;
      if (event.sourceEvent) autoFit = false;
      draw();
    });
  d3.select(canvas).call(zoom).call(zoom.transform, transform);

  function fitToView() {
    if (nodes.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const bboxW = Math.max(maxX - minX, 1), bboxH = Math.max(maxY - minY, 1);
    const scale = Math.min(width / bboxW, height / bboxH, 8) * 0.85;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const next = d3.zoomIdentity.translate(width / 2 - cx * scale, height / 2 - cy * scale).scale(scale);
    transform = next;
    d3.select(canvas).call(zoom.transform, next);
  }

  function neighborsOf(id) {
    const set = new Set();
    for (const l of links) {
      if (l.source.id === id) set.add(l.target.id);
      if (l.target.id === id) set.add(l.source.id);
    }
    return set;
  }

  // Scales a "#rrggbb" accent color down toward black, preserving hue —
  // used to darken a searched player's 1st-degree connections without
  // touching anyone else's brightness (including the searched player).
  function darkenColor(hex) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const f = 0.65;
    return 'rgb(' + Math.round(r * f) + ',' + Math.round(g * f) + ',' + Math.round(b * f) + ')';
  }

  function draw() {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#050505';
    ctx.fillRect(0, 0, width, height);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    if (showGroups) {
      for (const h of hulls) {
        ctx.beginPath();
        hullLine.context(ctx)(h.hull);
        ctx.fillStyle = h.color;
        ctx.globalAlpha = 0.1;
        ctx.fill();
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1.5 / transform.k;
        ctx.strokeStyle = h.color;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    for (const l of links) {
      const isPathLink = separationEdgeKeys && separationEdgeKeys.has(l.source.id + '|' + l.target.id);
      const isMatchLink = matchedId && (l.source.id === matchedId || l.target.id === matchedId);
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.strokeStyle = isPathLink ? '#fff' : (isMatchLink ? 'rgba(230,230,230,0.6)' : 'rgba(160,160,160,0.25)');
      ctx.lineWidth = (isPathLink ? Math.max(widthScale(l.weight), 2.5) : widthScale(l.weight)) / transform.k;
      ctx.stroke();
    }

    for (const n of nodes) {
      const onPath = separationPath && separationPath.includes(n.id);
      let fill = n.color;
      let alpha = n === hoverNode ? 1 : 0.9;
      if (matchedId && n.id !== matchedId && !onPath) {
        if (darkenIds.has(n.id)) {
          fill = darkenColor(n.color);
        } else {
          fill = 'rgb(70,70,70)';
          alpha = n === hoverNode ? 1 : 0.3;
        }
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.globalAlpha = alpha;
      ctx.fill();
      if (onPath) {
        ctx.lineWidth = 2 / transform.k;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      } else if (n === hoverNode) {
        ctx.lineWidth = 1.5 / transform.k;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    for (const h of (showGroups ? hulls : [])) {
      if (!h.label) continue;
      // Font size is set in world units and NOT compensated for zoom (no
      // "/ transform.k") — it shrinks and grows along with the blobs
      // themselves as the view zooms, same as nodes/edges, which is what
      // keeps zoomed-out labels from staying full-size and colliding. Every
      // community's label uses the same size, though — only the zoom level
      // varies it, not which community it belongs to.
      const fontWorld = HULL_LABEL_FONT_WORLD;
      ctx.font = '700 ' + fontWorld + 'px Rajdhani, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const textWidth = ctx.measureText(h.label).width;

      const flagImg = h.flag ? getFlagImage(h.flag.src) : null;
      let flagW = 0, flagH = 0, flagGap = 0;
      if (flagImg) {
        flagH = fontWorld * 0.9;
        flagW = flagH * (flagImg.naturalWidth / flagImg.naturalHeight);
        flagGap = fontWorld * 0.35;
      }

      const padX = fontWorld * 0.5, padY = fontWorld * 0.32;
      const boxW = flagW + flagGap + textWidth + padX * 2;
      const boxH = fontWorld + padY * 2;
      const boxX = h.labelX - boxW / 2;
      const boxY = h.labelY - boxH / 2;

      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, fontWorld * 0.25);
      ctx.fillStyle = 'rgba(5,5,5,0.75)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, fontWorld * 0.07);
      ctx.strokeStyle = h.color;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.globalAlpha = 1;

      let cursorX = boxX + padX;
      if (flagImg) {
        ctx.drawImage(flagImg, cursorX, h.labelY - flagH / 2, flagW, flagH);
        cursorX += flagW + flagGap;
      }
      ctx.fillStyle = '#f0f0f0';
      ctx.fillText(h.label, cursorX, h.labelY);
    }
    ctx.restore();
  }

  function screenToWorld(px, py) {
    return [(px - transform.x) / transform.k, (py - transform.y) / transform.k];
  }

  function nodeAt(px, py) {
    const [wx, wy] = screenToWorld(px, py);
    let best = null, bestDist = Infinity;
    for (const n of nodes) {
      const dx = n.x - wx, dy = n.y - wy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= n.r + 10 && dist < bestDist) { best = n; bestDist = dist; }
    }
    return best;
  }

  function showTooltip(n, px, py) {
    const flagImg = n.flag ? '<img class="t-flag" src="' + n.flag.src + '" title="' + n.flag.title + '" alt="' + n.flag.title + '">' : '';
    tooltip.innerHTML = '<div class="t-name">' + flagImg + n.name + '</div>' +
      '<div class="t-stat">' + n.games + ' game' + (n.games === 1 ? '' : 's') + ' \\u2022 ' + n.tournaments + ' tournament' + (n.tournaments === 1 ? '' : 's') + '</div>';
    tooltip.style.display = 'block';
    tooltip.style.left = (px + 16) + 'px';
    tooltip.style.top = (py + 16) + 'px';
  }
  function hideTooltip() { tooltip.style.display = 'none'; }

  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    if (dragging) {
      const [wx, wy] = screenToWorld(px, py);
      dragging.fx = wx; dragging.fy = wy;
      simulation.alphaTarget(0.2).restart();
      return;
    }
    const n = nodeAt(px, py);
    if (n !== hoverNode) { hoverNode = n; draw(); }
    if (n) { showTooltip(n, event.clientX, event.clientY); }
    else { hideTooltip(); }
  });

  canvas.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const n = nodeAt(event.clientX - rect.left, event.clientY - rect.top);
    if (n) {
      dragging = n;
      autoFit = false;
      canvas.classList.add('dragging');
    }
  });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging.fx = null;
      dragging.fy = null;
      dragging = null;
      canvas.classList.remove('dragging');
      simulation.alphaTarget(0);
    }
  });
  canvas.addEventListener('mouseleave', () => { hoverNode = null; hideTooltip(); });

  function setMode(mode) {
    currentMode = mode;
    modePlayedBtn.classList.toggle('active', mode === 'played');
    modeAttendedBtn.classList.toggle('active', mode === 'attended');
    const source = mode === 'played' ? GRAPH.played : GRAPH.attended;
    links = source.map((l) => ({ ...l }));
    widthScale.domain([1, d3.max(links, (l) => l.weight) || 1]).range([0.5, 4]);
    simulation.force('link').links(links);
    updateCommunitylessAffinity();
    autoFit = true;
    updateHulls();
    simulation.alpha(0.8).restart();
    graphStat.textContent = nodes.length + ' players \\u00b7 ' + links.length + ' connections';
    updateSeparation();
  }

  modePlayedBtn.addEventListener('click', () => setMode('played'));
  modeAttendedBtn.addEventListener('click', () => setMode('attended'));

  function selectSearchPlayer(match) {
    matchedId = match.id;
    darkenIds = neighborsOf(match.id);
    const targetScale = Math.max(transform.k, 1.4);
    const t = d3.zoomIdentity.translate(width / 2 - match.x * targetScale, height / 2 - match.y * targetScale).scale(targetScale);
    d3.select(canvas).transition().duration(500).call(zoom.transform, t);
    draw();
    updateSeparation();
  }

  // Shared by the "Find a player" and "Compare with" inputs — shows up to 6
  // name matches in a clickable dropdown, since typing enough of a common
  // name to land on one exact player via substring-highlight alone can be
  // slow or ambiguous (multiple players sharing a similar name).
  function renderAutocomplete(listEl, query, onPick) {
    listEl.innerHTML = '';
    const q = query.trim().toLowerCase();
    if (!q) { listEl.classList.remove('visible'); return; }
    const matches = nodes.filter((n) => n.name.toLowerCase().includes(q)).slice(0, 6);
    if (matches.length === 0) { listEl.classList.remove('visible'); return; }
    for (const m of matches) {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.textContent = m.name;
      // mousedown (not click) fires before the input's blur event, so the
      // dropdown's own hide-on-blur handler doesn't swallow the click first.
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        onPick(m);
        listEl.classList.remove('visible');
      });
      listEl.appendChild(item);
    }
    listEl.classList.add('visible');
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    renderAutocomplete(searchList, searchInput.value, (m) => { searchInput.value = m.name; searchList.classList.remove('visible'); selectSearchPlayer(m); });
    if (!q) { matchedId = null; darkenIds = null; draw(); updateSeparation(); return; }
    const match = nodes.find((n) => n.name.toLowerCase().includes(q));
    if (match) {
      selectSearchPlayer(match);
    } else {
      matchedId = null;
      darkenIds = null;
      draw();
      updateSeparation();
    }
  });
  searchInput.addEventListener('focus', () => renderAutocomplete(searchList, searchInput.value, (m) => { searchInput.value = m.name; searchList.classList.remove('visible'); selectSearchPlayer(m); }));
  searchInput.addEventListener('blur', () => setTimeout(() => searchList.classList.remove('visible'), 150));

  // Degrees of separation — BFS shortest path between the main search's
  // match and a second "compare with" player, over whichever mode's edges
  // are currently active (played-against or attended-same-tournament), so
  // the same two players can show a different separation per mode. Rebuilt
  // fresh per query rather than cached, since it depends on the current
  // (possibly just-changed) mode's link set.
  let compareId = null;
  function shortestPath(fromId, toId) {
    if (fromId === toId) return [fromId];
    const adjacent = new Map();
    for (const l of links) {
      const a = l.source.id, b = l.target.id;
      if (!adjacent.has(a)) adjacent.set(a, []);
      if (!adjacent.has(b)) adjacent.set(b, []);
      adjacent.get(a).push(b);
      adjacent.get(b).push(a);
    }
    const visited = new Set([fromId]);
    const prev = new Map();
    const queue = [fromId];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === toId) break;
      for (const next of (adjacent.get(cur) || [])) {
        if (visited.has(next)) continue;
        visited.add(next);
        prev.set(next, cur);
        queue.push(next);
      }
    }
    if (!visited.has(toId)) return null;
    const path = [toId];
    let cur = toId;
    while (cur !== fromId) { cur = prev.get(cur); path.push(cur); }
    path.reverse();
    return path;
  }
  function updateSeparation() {
    separationPath = null;
    separationEdgeKeys = null;
    if (!matchedId || !compareId) { separationOutput.innerHTML = ''; draw(); return; }
    if (matchedId === compareId) { separationOutput.textContent = 'Same player.'; draw(); return; }
    const path = shortestPath(matchedId, compareId);
    if (!path) {
      separationOutput.textContent = 'No connection found in this mode.';
      draw();
      return;
    }
    separationPath = path;
    separationEdgeKeys = new Set();
    for (let i = 0; i < path.length - 1; i++) {
      separationEdgeKeys.add(path[i] + '|' + path[i + 1]);
      separationEdgeKeys.add(path[i + 1] + '|' + path[i]);
    }
    const degrees = path.length - 1;
    const byId = new Map(nodes.map((n) => [n.id, n.name]));
    const names = path.map((id) => byId.get(id));
    const noun = currentMode === 'played' ? (degrees === 1 ? 'match' : 'matches') : (degrees === 1 ? 'tournament' : 'tournaments');
    separationOutput.innerHTML = '<span class="sep-degrees">' + degrees + '</span> degree' + (degrees === 1 ? '' : 's') + ' of separation (' + degrees + ' ' + noun + ' apart)<br>' + names.join(' &rarr; ');
    draw();
  }

  separationInput.addEventListener('input', () => {
    const q = separationInput.value.trim().toLowerCase();
    renderAutocomplete(separationList, separationInput.value, (m) => { separationInput.value = m.name; separationList.classList.remove('visible'); compareId = m.id; updateSeparation(); });
    if (!q) { compareId = null; updateSeparation(); return; }
    const match = nodes.find((n) => n.name.toLowerCase().includes(q));
    compareId = match ? match.id : null;
    updateSeparation();
  });
  separationInput.addEventListener('focus', () => renderAutocomplete(separationList, separationInput.value, (m) => { separationInput.value = m.name; separationList.classList.remove('visible'); compareId = m.id; updateSeparation(); }));
  separationInput.addEventListener('blur', () => setTimeout(() => separationList.classList.remove('visible'), 150));

  setMode('played');
  draw();
})();
</script>
</body>
</html>
`;

  const outPath = path.join(__dirname, '..', '..', 'player-graph.html');
  fs.writeFileSync(outPath, stripCommentsInHeadBlocks(html));
  console.log(`Wrote ${outPath}`);
}

if (require.main === module) {
  const graph = buildGraph();
  writePage(graph);
}

module.exports = { buildGraph };
