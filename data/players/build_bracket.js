// Builds a brackets-viewer.js-ready dataset (stages/matches/matchGames/
// participants) for a single/double-elimination tournament, by directly
// transcribing our own historical match data (round/order fields) into
// brackets-model's schema — rather than re-simulating the bracket from a
// seed list and hoping the guessed shape matches history.
//
// Earlier versions of this file fed a seed list to `brackets-manager` and
// let it independently invent a standard double-elimination tree, then
// matched its generated pairings against our real results by name. That
// works for the winners' bracket (there's one universal seeding convention,
// and Challonge/start.gg give us the real seed numbers), but there's no
// single standard for how losers get redistributed into the losers'
// bracket — different platforms use different interleaving conventions to
// avoid immediate rematches, and none of `brackets-manager`'s built-in
// orderings reliably matched what Challonge/start.gg actually did. That
// caused roughly half of double-elimination brackets to fail to reconstruct.
//
// We don't actually need to guess any of this: our source data's `round`
// (positive = winners bracket, negative = losers bracket, by convention
// already used elsewhere in this file) and `order` (chronological-ish
// sequence) fields already encode the true shape. brackets-viewer infers
// its layout purely from each match's group_id/round_id/number (verified
// empirically — it doesn't need separate Stage/Group/Round records, and it
// pairs up adjacent same-round matches positionally to feed the next
// round), so we only need to place our real matches into the right
// group/round/position — no seeding, no simulation, no brackets-manager.

'use strict';

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

const naturalOrder = (ms) => [...ms].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

// The same real player can appear under different casing across different
// start.gg sets/entrants (observed in practice — e.g. "RheaStarGirl" in one
// match, "RHEASTARGIRL" in another), which broke exact-string round-to-round
// pairing below and inserted spurious phantom byes for players who did in
// fact have a previous match. Match case-insensitively for pairing purposes
// only — the original casing is preserved for display/participant records.
const norm = (name) => (name || '').toLowerCase();

// Tiny deterministic string hash (djb2), used to mix winner/loser display
// order — see pushMatch. Stable across regenerations by construction.
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

// Byes most commonly occur in winners'-bracket round 1 (to pad a non-power-
// of-two field), but a field that drops an odd number of players between
// rounds (a mid-event no-show/DQ, not just the initial field size) can leave
// a genuine bye at a *later* WB round too — the surviving side of that
// round simply has no round-N+1 opponent from the same slot. Rather than
// guess which round-N slot pairs with which round-N+1 match, we drive the
// construction the other way: for each round-N+1 match (in its already-
// finalized order — see pushGroup), look up each opponent's round-N match
// if they have one — if not, they had a bye, and we synthesize a
// placeholder — and lay both down adjacently. That guarantees round N's
// array stays in the 2-per-round-N+1-match order brackets-viewer's
// positional pairing expects (a count mismatch here is what previously
// caused a lopsided bracket's later rounds to visually compress/overlap,
// since brackets-viewer's spacing assumes each round has exactly half the
// previous round's match count).
function buildWbRound(roundMatches, nextRoundMatches) {
  if (nextRoundMatches.length === 0) return naturalOrder(roundMatches);

  const byPlayer = new Map();
  for (const m of roundMatches) {
    byPlayer.set(norm(m.winnerName), m);
    byPlayer.set(norm(m.loserName), m);
  }

  const ordered = [];
  const placed = new Set();
  for (const next of nextRoundMatches) {
    for (const player of [next.winnerName, next.loserName]) {
      const feeder = byPlayer.get(norm(player));
      if (feeder) {
        if (!placed.has(feeder)) { ordered.push(feeder); placed.add(feeder); }
      } else {
        ordered.push({ byePlayer: player }); // synthetic — no real match this round
      }
    }
  }
  // Any match whose winner didn't appear next round at all (shouldn't
  // normally happen since every real match must end up placed somewhere) is
  // appended at the end, defensively.
  for (const m of roundMatches) if (!placed.has(m)) ordered.push(m);
  return ordered;
}

// Orders a round's matches to align positionally with the next round (given
// in its already-finalized order — see pushGroup): for each next-round
// match, place whichever of its two players' current-round match (the one
// they *won*, to advance) hasn't already been placed. This isn't a strict
// 2-into-1 fold — a losers-bracket round can mix survivors advancing from
// its own previous round with fresh winners-bracket droppers who have no
// current-round match at all — so unlike round 1 of the winners bracket, no
// placeholder is synthesized for "no feeder"; that participant simply
// arrived from elsewhere and doesn't need a box in this round.
function orderRoundForNext(currentMatches, nextMatches) {
  if (nextMatches.length === 0) return naturalOrder(currentMatches);
  const winnerMatch = new Map(currentMatches.map((m) => [norm(m.winnerName), m]));
  const ordered = [];
  const placed = new Set();
  for (const nm of nextMatches) {
    for (const player of [nm.winnerName, nm.loserName]) {
      const feeder = winnerMatch.get(norm(player));
      if (feeder && !placed.has(feeder)) { ordered.push(feeder); placed.add(feeder); }
    }
  }
  for (const m of currentMatches) if (!placed.has(m)) ordered.push(m);
  return ordered;
}

async function buildBracketData(t) {
  const isDoubleElim = t.source === 'Challonge'
    ? t.tournamentType === 'double elimination'
    : t.matches.some((m) => m.round != null && m.round < 0);
  const isSingleElim = t.source === 'Challonge'
    ? t.tournamentType === 'single elimination'
    : !isDoubleElim;
  if (!isDoubleElim && !isSingleElim) return null; // round robin / swiss — not our shape

  const named = t.participantList.filter((p) => p.name);
  if (named.length < 2) return null;

  const realMatches = t.matches.filter((m) => m.winnerName && m.loserName);
  if (realMatches.length === 0) return null;
  if (realMatches.some((m) => m.round == null)) return null; // can't place reliably

  // round === 0 shows up on consolation/3rd-place matches (a side bracket,
  // not part of the main elimination tree) — drop them rather than aborting
  // the whole reconstruction over a match that was never really "in" it.
  const sorted = realMatches.filter((m) => m.round !== 0).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Bracket size (and hence the expected number of winners-bracket rounds)
  // is based on participants who actually played at least one real match —
  // a registrant who no-showed and never appears in any match would
  // otherwise inflate the count, throwing off which round is the true WB
  // final and everything downstream of that (incomplete-detection, pending
  // rounds, the grand-final search window).
  const activeNames = new Set(sorted.flatMap((m) => [m.winnerName, m.loserName]));
  const activeCount = named.filter((p) => activeNames.has(p.name)).length;
  const size = nextPow2(activeCount);
  const expectedWbRounds = Math.round(Math.log2(size));

  // Grand final (double elim only): the winners'-bracket champion's next
  // match(es) after the true WB final (round === expectedWbRounds) — not
  // simply "the chronologically last match", since an abandoned tournament
  // (no grand final ever played) would otherwise have its WB final
  // mislabeled as the grand final. Two GF matches means a bracket reset.
  let gfMatches = [];
  let wbChampion = null;
  if (isDoubleElim) {
    const wbFinalMatches = sorted.filter((m) => m.round === expectedWbRounds);
    wbChampion = wbFinalMatches.length === 1 ? wbFinalMatches[0].winnerName : null;
    const wbFinalOrder = wbFinalMatches.length ? Math.max(...wbFinalMatches.map((m) => m.order ?? 0)) : Infinity;
    if (wbChampion) {
      const champNorm = norm(wbChampion);
      gfMatches = sorted.filter((m) => (m.order ?? 0) > wbFinalOrder && (norm(m.winnerName) === champNorm || norm(m.loserName) === champNorm));
      if (gfMatches.length > 2) gfMatches = gfMatches.slice(-2); // defensive cap
    }
  }
  const gfSet = new Set(gfMatches);

  if (!isDoubleElim && sorted.some((m) => m.round < 0)) return null; // inconsistent data for a single-elim tournament

  // Sanity check: a true WB champion, by definition, never lost a winners-
  // bracket match, so they can never have a losers-bracket appearance. If
  // they do, our round === expectedWbRounds guess for "the true WB final"
  // landed on the wrong round for this tournament (e.g. an unusual bracket
  // shape, or a genuine data anomaly) — abort rather than build a bracket
  // around a wrong premise.
  if (isDoubleElim && wbChampion) {
    const lbNames = new Set(sorted.filter((m) => m.round < 0).flatMap((m) => [norm(m.winnerName), norm(m.loserName)]));
    if (lbNames.has(norm(wbChampion))) return null;
  }

  const wbMatches = sorted.filter((m) => m.round > 0 && !gfSet.has(m));
  const lbMatches = isDoubleElim ? sorted.filter((m) => m.round < 0 && !gfSet.has(m)) : [];
  if (wbMatches.length + lbMatches.length + gfMatches.length !== sorted.length) return null; // some match had round === 0 or other unplaceable data

  // Keyed by normalized name so the same casing inconsistency that broke
  // round-to-round pairing (see `norm` above) doesn't also register the same
  // real person as two separate participants with near-duplicate boxes.
  // The first-seen casing is kept for display.
  const participantIds = new Map();
  const participantDisplayNames = new Map();
  let nextParticipantId = 0;
  const pid = (name) => {
    const key = norm(name);
    if (!participantIds.has(key)) {
      participantIds.set(key, nextParticipantId++);
      participantDisplayNames.set(key, name);
    }
    return participantIds.get(key);
  };

  const matches = [];
  let nextMatchId = 0;
  let nextRoundId = 0;

  // `firstPlayer` (optional) forces that player into the opponent1 slot
  // regardless of who won — see the grand-final push below for why. Without
  // it, top/bottom is decided by hashing the pairing: a real bracket's slot
  // order comes from seeding, so winners land on top only about half the
  // time — always putting the winner first read as artificial. We don't
  // have true slot data, so a stable hash stands in for it.
  function pushMatch(groupId, roundId, number, entry, firstPlayer) {
    if (entry.byePlayer) {
      matches.push({
        id: nextMatchId++, stage_id: 0, group_id: groupId, round_id: roundId, number, child_count: 0,
        status: 4, opponent1: { id: pid(entry.byePlayer), result: 'win' }, opponent2: null,
      });
      return;
    }
    const winner = { id: pid(entry.winnerName), score: entry.winnerSets ?? 1, result: 'win' };
    const loser = { id: pid(entry.loserName), score: entry.loserSets ?? 0, result: 'loss', forfeit: entry.isDQ || undefined };
    const swap = firstPlayer != null
      ? norm(entry.loserName) === norm(firstPlayer)
      : hashStr(norm(entry.winnerName) + '|' + norm(entry.loserName) + '|' + groupId + ':' + roundId) % 2 === 1;
    matches.push({
      id: nextMatchId++, stage_id: 0, group_id: groupId, round_id: roundId, number, child_count: 0,
      status: 4,
      opponent1: swap ? loser : winner,
      opponent2: swap ? winner : loser,
    });
  }

  function pushPendingMatch(groupId, roundId, number, pm) {
    matches.push({
      id: nextMatchId++, stage_id: 0, group_id: groupId, round_id: roundId, number, child_count: 0,
      status: (pm.player1Name && pm.player2Name) ? 2 : 1,
      opponent1: pm.player1Name ? { id: pid(pm.player1Name) } : { id: null },
      opponent2: pm.player2Name ? { id: pid(pm.player2Name) } : { id: null },
    });
  }

  // Pushes a group's matches, grouped by real round value (via `roundKey`),
  // in ascending round order. Each round's final display order is computed
  // back-to-front — starting at the group's last round and working toward
  // round 1 — via `orderMatches(currentRoundMatches, nextRoundFinalOrder,
  // key)`, so every round aligns against its successor's *already-finalized*
  // order rather than a raw guess that round might later reorder itself
  // when its own turn comes (which is what happened when this instead
  // processed strictly forward: each round would tentatively align to
  // whatever order the next round's matches happened to appear in the
  // source data, only for that next round to then be reordered relative to
  // the round after it — silently invalidating the earlier alignment and
  // compounding into visibly mismatched connectors a few rounds down a long
  // losers-bracket chain).
  // `pendingByRound` (optional, round value → pending matches) appends the
  // source's known-but-unplayed matches into the round they really belong
  // to. An abandoned bracket can stop mid-round — some round-N matches
  // played, others never — and only showing pending matches *after* the
  // last played round hid those gaps entirely (along with everyone in
  // them who was still waiting to play).
  function pushGroup(groupId, groupMatches, roundKey, orderMatches, pendingByRound) {
    const byRound = new Map();
    for (const m of groupMatches) {
      const key = roundKey(m);
      if (!byRound.has(key)) byRound.set(key, []);
      byRound.get(key).push(m);
    }
    const roundValues = [...byRound.keys()].sort((a, b) => a - b);

    const finalOrder = new Map();
    for (let i = roundValues.length - 1; i >= 0; i--) {
      const key = roundValues[i];
      const nextFinal = i + 1 < roundValues.length ? finalOrder.get(roundValues[i + 1]) : [];
      finalOrder.set(key, orderMatches(byRound.get(key), nextFinal, key));
    }

    for (const key of roundValues) {
      const roundId = nextRoundId++;
      const entries = finalOrder.get(key);
      entries.forEach((entry, idx) => pushMatch(groupId, roundId, idx + 1, entry));
      const pend = (pendingByRound && pendingByRound.get(key)) || [];
      [...pend].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .forEach((pm, i) => pushPendingMatch(groupId, roundId, entries.length + i + 1, pm));
    }
    return roundValues;
  }

  // The source (Challonge/start.gg) usually already knows the exact pairing
  // for not-yet-played matches — see `pendingMatches` in aggregate_players.js's
  // collect* functions. Grouped by the round they belong to: rounds that
  // already have real matches get them merged in via pushGroup above, fully
  // future rounds get their own columns below.
  const pending = (t.pendingMatches || []).filter((p) => p.round !== 0);
  const wbPendingByRound = new Map();
  const lbPendingByRound = new Map();
  for (const p of pending) {
    if (p.round > 0 && p.round <= expectedWbRounds) {
      if (!wbPendingByRound.has(p.round)) wbPendingByRound.set(p.round, []);
      wbPendingByRound.get(p.round).push(p);
    } else if (p.round < 0) {
      const r = Math.abs(p.round);
      if (!lbPendingByRound.has(r)) lbPendingByRound.set(r, []);
      lbPendingByRound.get(r).push(p);
    }
  }

  // WB group (0): every round needs the bye-aware interleave against the
  // round after it — byes are most common in round 1, but an odd number of
  // survivors at any later round is a real (if rarer) possibility too.
  const wbRoundValues = [...new Set(wbMatches.map((m) => m.round))].sort((a, b) => a - b);
  pushGroup(0, wbMatches, (m) => m.round, (ms, nextMs) => buildWbRound(ms, nextMs), wbPendingByRound);

  // LB group (1): each round aligns positionally with the round after it —
  // a losers-bracket round can be a 2-into-1 merge or a 1-into-1 passthrough
  // (or, with an irregular bye distribution, a mix of both within the same
  // round), so this can't assume a fixed ratio the way WB round 1 can.
  const lbRoundValues = isDoubleElim ? [...new Set(lbMatches.map((m) => Math.abs(m.round)))].sort((a, b) => a - b) : [];
  if (isDoubleElim) pushGroup(1, lbMatches, (m) => Math.abs(m.round), (ms, nextMs) => orderRoundForNext(ms, nextMs), lbPendingByRound);

  // GF group (2): 1 round (no reset) or 2 (reset happened) — we only create
  // the reset round if one actually took place, unlike a simulated bracket
  // which always reserves an (often permanently empty) reset slot.
  if (isDoubleElim && gfMatches.length > 0) {
    // brackets-viewer decides whether to display a bracket-reset match by
    // checking whether opponent1 of the *first* grand-final match — the WB
    // champion, by its convention — won it. pushMatch's default winner-first
    // ordering broke that convention whenever the LB champion won the first
    // grand final, making the viewer silently drop the reset match that
    // really happened; pin the WB champion to opponent1 instead.
    for (const m of gfMatches) pushMatch(2, nextRoundId++, 1, m, wbChampion);
  }

  // If a bracket stopped short of its natural conclusion, show exactly one
  // round of "pending" placeholder matches for whatever comes next — not
  // further, since we have no real data to know how those would pair up.
  // Participants are filled in wherever already determined (e.g. a pending
  // grand final always knows its winners-bracket entrant).
  function addPendingRound(groupId, lastRoundMatches) {
    if (lastRoundMatches.length === 0) return;
    const winners = [...lastRoundMatches].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((m) => m.winnerName);
    const roundId = nextRoundId++;
    let num = 1;
    for (let i = 0; i < winners.length; i += 2) {
      const p1 = winners[i];
      const p2 = winners[i + 1];
      matches.push({
        id: nextMatchId++, stage_id: 0, group_id: groupId, round_id: roundId, number: num++, child_count: 0,
        status: p2 != null ? 2 : 1,
        opponent1: { id: pid(p1) },
        opponent2: p2 != null ? { id: pid(p2) } : { id: null },
      });
    }
  }

  // Prefer the source's real pending data over the winners-of-the-last-round
  // guess above: the guess can only ever account for a single subsequent
  // round and gets the pairing outright wrong once more than one round
  // remains unplayed (e.g. a losers-bracket final still pending gets
  // mistaken for an already-decided losers champion, corrupting the
  // grand-final guess downstream too). With real data we're not guessing,
  // so every known future round gets its column, not just the next one.
  function addRealPendingRound(groupId, roundMatches) {
    if (roundMatches.length === 0) return false;
    const ordered = [...roundMatches].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const roundId = nextRoundId++;
    ordered.forEach((pm, idx) => pushPendingMatch(groupId, roundId, idx + 1, pm));
    return true;
  }

  if (wbRoundValues.length < expectedWbRounds) {
    const lastWbRound = wbRoundValues.length ? wbRoundValues[wbRoundValues.length - 1] : 0;
    let addedReal = false;
    for (let r = lastWbRound + 1; r <= expectedWbRounds; r++) {
      if (!addRealPendingRound(0, wbPendingByRound.get(r) || [])) break;
      addedReal = true;
    }
    if (!addedReal) addPendingRound(0, wbMatches.filter((m) => m.round === lastWbRound));
  }

  let lbChampion = null;
  if (isDoubleElim && lbRoundValues.length > 0) {
    const lastLbRound = lbRoundValues[lbRoundValues.length - 1];
    let addedReal = false;
    for (let r = lastLbRound + 1; ; r++) {
      if (!addRealPendingRound(1, lbPendingByRound.get(r) || [])) break;
      addedReal = true;
    }
    if (!addedReal) {
      const lastLbRoundMatches = lbMatches.filter((m) => Math.abs(m.round) === lastLbRound);
      if (lastLbRoundMatches.length > 1) addPendingRound(1, lastLbRoundMatches);
      else lbChampion = lastLbRoundMatches[0].winnerName;
    }
  }

  if (isDoubleElim && gfMatches.length === 0 && wbChampion) {
    const gfPending = pending.find((p) => p.round === expectedWbRounds + 1 && (p.player1Name || p.player2Name));
    const gfP1 = gfPending?.player1Name || wbChampion;
    const gfP2 = gfPending?.player2Name || lbChampion;
    matches.push({
      id: nextMatchId++, stage_id: 0, group_id: 2, round_id: nextRoundId++, number: 1, child_count: 0,
      status: gfP2 ? 2 : 1,
      opponent1: { id: pid(gfP1) },
      opponent2: gfP2 ? { id: pid(gfP2) } : { id: null },
    });
  }

  // Unfinished if the winners bracket didn't reach its expected depth, or
  // (double elim) the champion's grand final was never actually played —
  // e.g. the event was abandoned partway through. (We don't check the
  // losers bracket's round count against a formula: byes reduce how many
  // LB rounds are actually needed in a way that isn't a simple function of
  // entrant count, so that check produced false positives.)
  const incomplete = wbRoundValues.length < expectedWbRounds || (isDoubleElim && gfMatches.length === 0);

  const stageType = isDoubleElim ? 'double_elimination' : 'single_elimination';
  return {
    stages: [{ id: 0, tournament_id: 0, name: t.label, type: stageType, number: 1, settings: {} }],
    matches,
    matchGames: [],
    participants: [...participantIds.entries()].map(([key, id]) => ({ id, tournament_id: 0, name: participantDisplayNames.get(key) })),
    incomplete,
  };
}

module.exports = { buildBracketData };
