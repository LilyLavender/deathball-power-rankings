// Minimal multi-level Louvain community detection (Blondel et al. 2008), no
// external deps. Used by player_graph.js to auto-group players into visual
// clusters for the "attended"/"played" background blobs — not a general
// utility, kept local to the experiment.

// Seeded PRNG (mulberry32) instead of Math.random() — the local-moving
// phase's traversal order affects which communities nodes settle into, so
// an unseeded shuffle would reshuffle community numbering (and therefore
// names/colors) on every regeneration even when nothing in the underlying
// tournament data changed, producing a confusing, unnecessarily large diff
// in the committed output each time it's re-run.
function seededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = seededRandom(0xdeadba11);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// One pass of local moving: greedily reassigns each node to whichever
// neighboring community maximizes modularity gain, until no node moves.
function oneLevel(nodes, edges) {
  const k = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map(nodes.map((n) => [n, new Map()]));
  let m2 = 0;
  for (const e of edges) {
    const w = e.weight;
    if (e.source === e.target) {
      k.set(e.source, k.get(e.source) + 2 * w);
      m2 += 2 * w;
      continue;
    }
    k.set(e.source, k.get(e.source) + w);
    k.set(e.target, k.get(e.target) + w);
    adj.get(e.source).set(e.target, (adj.get(e.source).get(e.target) || 0) + w);
    adj.get(e.target).set(e.source, (adj.get(e.target).get(e.source) || 0) + w);
    m2 += 2 * w;
  }
  if (m2 === 0) return { communityOf: new Map(nodes.map((n) => [n, n])), improved: false };

  const community = new Map(nodes.map((n) => [n, n]));
  const sigmaTot = new Map(nodes.map((n) => [n, k.get(n)]));

  let improved = false;
  let anyMove = true;
  let guard = 0;
  while (anyMove && guard < 100) {
    anyMove = false;
    guard += 1;
    for (const node of shuffle(nodes.slice())) {
      const nodeComm = community.get(node);
      const ki = k.get(node);
      sigmaTot.set(nodeComm, sigmaTot.get(nodeComm) - ki);

      const neighborWeights = new Map();
      for (const [nbr, w] of adj.get(node).entries()) {
        const nbrComm = community.get(nbr);
        neighborWeights.set(nbrComm, (neighborWeights.get(nbrComm) || 0) + w);
      }
      if (!neighborWeights.has(nodeComm)) neighborWeights.set(nodeComm, 0);

      let bestComm = nodeComm;
      let bestGain = 0;
      for (const [comm, w] of neighborWeights.entries()) {
        const gain = w - (sigmaTot.get(comm) * ki) / m2;
        if (gain > bestGain) { bestGain = gain; bestComm = comm; }
      }

      sigmaTot.set(bestComm, (sigmaTot.get(bestComm) || 0) + ki);
      if (bestComm !== nodeComm) {
        community.set(node, bestComm);
        anyMove = true;
        improved = true;
      }
    }
  }
  return { communityOf: community, improved };
}

// Collapses each community from a level into a single super-node, carrying
// summed inter/intra-community edge weight forward as the next level's input.
function aggregate(nodes, edges, communityOf) {
  const commIds = [...new Set(nodes.map((n) => communityOf.get(n)))];
  const edgeWeights = new Map();
  for (const e of edges) {
    const ca = communityOf.get(e.source), cb = communityOf.get(e.target);
    const key = ca <= cb ? `${ca}|${cb}` : `${cb}|${ca}`;
    edgeWeights.set(key, (edgeWeights.get(key) || 0) + e.weight);
  }
  const newEdges = [...edgeWeights.entries()].map(([key, weight]) => {
    const [source, target] = key.split('|');
    return { source, target, weight };
  });
  return { nodes: commIds, edges: newEdges };
}

// nodeIds: array of node id strings. edges: [{source, target, weight}].
// Returns Map<nodeId, communityIndex> with communities renumbered 0..k-1,
// largest first.
function louvain(nodeIds, edges) {
  let currentNodes = nodeIds.slice();
  let currentEdges = edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight }));
  const membership = new Map(nodeIds.map((id) => [id, id]));

  let level = 0;
  while (level < 20) {
    const { communityOf, improved } = oneLevel(currentNodes, currentEdges);
    if (!improved) break;
    for (const [origId, curId] of membership.entries()) {
      membership.set(origId, communityOf.get(curId));
    }
    const agg = aggregate(currentNodes, currentEdges, communityOf);
    if (agg.nodes.length === currentNodes.length) break;
    currentNodes = agg.nodes;
    currentEdges = agg.edges;
    level += 1;
  }

  const sizeByComm = new Map();
  for (const comm of membership.values()) sizeByComm.set(comm, (sizeByComm.get(comm) || 0) + 1);
  const ranked = [...sizeByComm.entries()].sort((a, b) => b[1] - a[1]).map(([comm]) => comm);
  const indexByComm = new Map(ranked.map((comm, i) => [comm, i]));

  return new Map([...membership.entries()].map(([id, comm]) => [id, indexByComm.get(comm)]));
}

// What fraction of each node's total edge weight stays inside its own
// assigned community, per communityOf. Returns Map<nodeId, ratio-or-null>
// (null for a node with zero edges in this edge set). Shared by
// refineCommunities (for its own/total threshold check) and by callers that
// want the same signal for a different purpose — e.g. player_graph.js uses
// it to flag which members are "core" enough to shape a community's visual
// hull, since that's a purely structural (graph-topology) property that
// never changes tick to tick, unlike a node's live simulated position.
function computeInternalRatio(nodeIds, edges, communityOf) {
  const totalWeight = new Map(nodeIds.map((id) => [id, 0]));
  const ownWeight = new Map(nodeIds.map((id) => [id, 0]));
  for (const e of edges) {
    totalWeight.set(e.source, (totalWeight.get(e.source) || 0) + e.weight);
    totalWeight.set(e.target, (totalWeight.get(e.target) || 0) + e.weight);
    if (communityOf.get(e.source) === communityOf.get(e.target)) {
      ownWeight.set(e.source, (ownWeight.get(e.source) || 0) + e.weight);
      ownWeight.set(e.target, (ownWeight.get(e.target) || 0) + e.weight);
    }
  }
  const ratio = new Map();
  for (const id of nodeIds) {
    const total = totalWeight.get(id) || 0;
    ratio.set(id, total === 0 ? null : (ownWeight.get(id) || 0) / total);
  }
  return ratio;
}

// Louvain assigns every node to *some* community, even ones only weakly (or
// accidentally, via a single bridge edge) attached to it. For display, a
// node doesn't really "belong" to a group if either (a) its own community
// accounts for less than `threshold` of its total edge weight, or (b) it
// simply hasn't played/attended with enough distinct people yet to say it's
// part of a group rather than a lone pairing (`minDegree`) — demote those to
// no community (null) rather than forcing them into a background blob.
function refineCommunities(nodeIds, edges, communityOf, threshold, minDegree) {
  const ratio = computeInternalRatio(nodeIds, edges, communityOf);
  const neighbors = new Map(nodeIds.map((id) => [id, new Set()]));
  for (const e of edges) {
    neighbors.get(e.source).add(e.target);
    neighbors.get(e.target).add(e.source);
  }
  const refined = new Map();
  for (const id of nodeIds) {
    const r = ratio.get(id);
    if (r === null || neighbors.get(id).size < minDegree) { refined.set(id, null); continue; }
    refined.set(id, r >= threshold ? communityOf.get(id) : null);
  }
  return refined;
}

module.exports = { louvain, refineCommunities, computeInternalRatio };
