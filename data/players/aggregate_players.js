// Aggregate per-player stats (record, win%, games played, tournaments
// attended) across ../challonge/tournaments.json and ../start.gg/tournaments.json,
// and build a flat list of all tournaments.
//
// Applies manual dedup/identity config from data/player-identities.json
// (alias merges + name-collision splits), and enriches output with
// data/player-info.json (location, contact) and data/tournament-locations.json.
//
// Usage: node aggregate_players.js
// Writes:
//   data/players/players.csv
//   index.html / index.css / index.js (repo root)

const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(__dirname, '..', '..');

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const identities = readJson(path.join(DATA_ROOT, 'player-identities.json'), { aliases: [], splits: [] });
const playerInfo = readJson(path.join(DATA_ROOT, 'player-info.json'), { players: {} }).players || {};
const tournamentLocations = readJson(path.join(DATA_ROOT, 'tournament-locations.json'), { locations: {} }).locations || {};

function normName(name) {
  return (name || '').trim();
}

// participant.name is blank when the player registered via their Challonge
// account instead of a custom name; username covers that case, falling back
// further to display_name for invited-but-unlinked participants. display_name
// bakes in a literal " (invitation pending)" suffix for unaccepted invites,
// which we strip since it's not part of the player's actual name.
function resolveParticipantName(p) {
  const raw = p.name || p.username || p.display_name || '';
  return raw.replace(/ \(invitation pending\)$/, '');
}

// Resolve a raw name (as it appears in tournament data) to its canonical
// form, using the manual config. Splits are checked first (they need the
// tournament context to disambiguate), then simple aliases.
function resolveCanonicalName(rawName, tournamentUrl) {
  const trimmed = normName(rawName);
  const lower = trimmed.toLowerCase();

  const split = (identities.splits || []).find((s) => normName(s.name).toLowerCase() === lower);
  if (split) {
    const resolution = (split.resolutions || []).find((r) => (r.tournaments || []).includes(tournamentUrl));
    if (resolution) return resolution.canonical;
    if (split.default) return split.default;
  }

  const alias = (identities.aliases || []).find((a) => (a.names || []).some((n) => normName(n).toLowerCase() === lower));
  if (alias) return alias.canonical;

  return trimmed;
}

// Players are then merged case-insensitively (e.g. "corley" / "Corley"
// from different sources), keeping whichever capitalization shows up most.
function getPlayer(map, canonicalName) {
  if (!canonicalName) return null;
  const key = canonicalName.toLowerCase();
  if (!map.has(key)) {
    map.set(key, {
      wins: 0, losses: 0, games: 0,
      tournaments: new Map(), // url -> label; multiple tournaments share names, so key by url
      nameCounts: new Map(),
    });
  }
  const player = map.get(key);
  player.nameCounts.set(canonicalName, (player.nameCounts.get(canonicalName) || 0) + 1);
  return player;
}

function displayName(player) {
  return [...player.nameCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function recordMatch(map, winnerRawName, loserRawName, tournamentUrl, tournamentLabel) {
  const winner = getPlayer(map, resolveCanonicalName(winnerRawName, tournamentUrl));
  const loser = getPlayer(map, resolveCanonicalName(loserRawName, tournamentUrl));
  if (!winner || !loser) return;
  winner.wins += 1;
  winner.games += 1;
  winner.tournaments.set(tournamentUrl, tournamentLabel);
  loser.losses += 1;
  loser.games += 1;
  loser.tournaments.set(tournamentUrl, tournamentLabel);
}

// city/state are the general location, `location` is the specific venue
// (a bar, arcade, convention hall, etc) — combined as "Venue, City, ST".
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

function processChallonge(map, tournaments) {
  const store = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'challonge', 'tournaments.json'), 'utf8'));
  for (const [url, rec] of Object.entries(store)) {
    if (!rec.tournament) continue;
    const t = rec.tournament;
    const label = t.name.trim();
    const location = resolveLocation(url, null);

    tournaments.push({
      name: label,
      url,
      date: resolveDate(url, (t.started_at || t.created_at || '').slice(0, 10)),
      location,
      participants: t.participants.length,
      matches: t.matches.length,
      source: 'Challonge',
    });

    const nameById = new Map(t.participants.map((p) => [p.participant.id, resolveParticipantName(p.participant)]));
    for (const m of t.matches) {
      const mm = m.match;
      if (!mm.winner_id || !mm.loser_id) continue;
      const winnerName = nameById.get(mm.winner_id);
      const loserName = nameById.get(mm.loser_id);
      if (!winnerName || !loserName) continue;
      recordMatch(map, winnerName, loserName, url, label);
    }
  }
}

function processStartgg(map, tournaments) {
  const store = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'start.gg', 'tournaments.json'), 'utf8'));
  for (const [url, rec] of Object.entries(store)) {
    if (!rec.entrants || !rec.sets) continue;
    const label = rec.tournament.name.trim();
    const location = resolveLocation(url, { city: rec.tournament.city, state: rec.tournament.addrState });

    tournaments.push({
      name: label,
      url,
      date: resolveDate(url, rec.tournament.startAt ? new Date(rec.tournament.startAt * 1000).toISOString().slice(0, 10) : ''),
      location,
      participants: rec.entrants.length,
      matches: rec.sets.length,
      source: 'start.gg',
    });

    const nameByEntrantId = new Map(
      rec.entrants.map((e) => [e.id, e.participants[0]?.gamerTag])
    );
    for (const s of rec.sets) {
      if (!s.winnerId || s.slots.length !== 2 || !s.slots.every((sl) => sl.entrant)) continue;
      const loserSlot = s.slots.find((sl) => sl.entrant.id !== s.winnerId);
      if (!loserSlot) continue;
      const winnerName = nameByEntrantId.get(s.winnerId);
      const loserName = nameByEntrantId.get(loserSlot.entrant.id);
      if (!winnerName || !loserName) continue;
      recordMatch(map, winnerName, loserName, url, label);
    }
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildPlayerRows(players, tournamentLocationByUrl) {
  return [...players.values()]
    .map((p) => {
      const name = displayName(p);
      const info = playerInfo[name] || {};
      return {
        name,
        wins: p.wins,
        losses: p.losses,
        games: p.games,
        winPct: p.games > 0 ? p.wins / p.games : 0,
        location: info.location || '',
        contact: info.contact || {},
        tournaments: [...p.tournaments.entries()].map(([url, label]) => ({
          url,
          label,
          location: tournamentLocationByUrl.get(url) || '',
        })),
      };
    })
    .sort((a, b) => b.winPct - a.winPct || b.games - a.games);
}

function contactString(contact) {
  return Object.entries(contact)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
}

function writeCsv(rows) {
  const header = ['Player', 'Wins', 'Losses', 'Games Played', 'Win %', 'Location', 'Contact', 'Tournament Count', 'Tournaments'];
  const csvRows = rows.map((p) => [
    p.name, p.wins, p.losses, p.games, (p.winPct * 100).toFixed(1),
    p.location, contactString(p.contact),
    p.tournaments.length,
    p.tournaments.map((t) => t.label).join('; '),
  ]);
  const csv = [header, ...csvRows]
    .map((row) => row.map((v) => (typeof v === 'string' && (v.includes(',') || v.includes(';')) ? `"${v.replace(/"/g, '""')}"` : v)).join(','))
    .join('\n');
  fs.writeFileSync(path.join(__dirname, 'players.csv'), csv);
}

function writeCss() {
  const css = `body { font-family: system-ui, sans-serif; margin: 2rem; background: #111; color: #eee; }
h1 { font-size: 1.3rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #333; text-align: left; vertical-align: top; }
th { cursor: pointer; user-select: none; position: sticky; top: 0; background: #1a1a1a; }
th:hover { background: #222; }
th.sorted-asc::after { content: " \\25B2"; }
th.sorted-desc::after { content: " \\25BC"; }
tr:hover { background: #1c1c1c; }
a { color: #6cf; text-decoration: none; }
a:hover { text-decoration: underline; }
.numeric { text-align: right; }
#count { color: #888; margin-bottom: 1rem; }
.tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; border-bottom: 1px solid #333; }
.tab-button { background: none; border: none; color: #aaa; font-size: 1rem; padding: 0.6rem 1rem; cursor: pointer; }
.tab-button:hover { color: #eee; }
.tab-button.active { color: #6cf; border-bottom: 2px solid #6cf; }
.tab-panel { display: none; }
.tab-panel.active { display: block; }
`;
  fs.writeFileSync(path.join(REPO_ROOT, 'index.css'), css);
}

function writeJs() {
  const js = `(function () {
  function enableSorting(table) {
    const tbody = table.tBodies[0];
    const headers = [...table.querySelectorAll('th')];
    headers.forEach((th, colIndex) => {
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
          const valA = cellA.textContent.trim().toLowerCase();
          const valB = cellB.textContent.trim().toLowerCase();
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

  document.querySelectorAll('table[data-sortable]').forEach(enableSorting);
  enableTabs();
})();
`;
  fs.writeFileSync(path.join(REPO_ROOT, 'index.js'), js);
}

function writeHtml(playerRows, tournamentRows) {
  const playerTableRows = playerRows.map((p) => {
    const tournamentLinks = p.tournaments
      .map((t) => `<a href="${escapeHtml(t.url)}" target="_blank" rel="noopener"${t.location ? ` title="${escapeHtml(t.location)}"` : ''}>${escapeHtml(t.label)}</a>`)
      .join(', ');
    const contact = contactString(p.contact);
    return `<tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.location)}</td>
      <td>${escapeHtml(contact)}</td>
      <td class="numeric" data-sort="${p.wins}">${p.wins}</td>
      <td class="numeric" data-sort="${p.losses}">${p.losses}</td>
      <td class="numeric" data-sort="${p.games}">${p.games}</td>
      <td class="numeric" data-sort="${p.winPct}">${(p.winPct * 100).toFixed(1)}%</td>
      <td class="numeric" data-sort="${p.tournaments.length}">${p.tournaments.length}</td>
      <td>${tournamentLinks}</td>
    </tr>`;
  }).join('\n');

  const tournamentTableRows = [...tournamentRows]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .map((t) => `<tr>
      <td><a href="${escapeHtml(t.url)}" target="_blank" rel="noopener">${escapeHtml(t.name)}</a></td>
      <td data-sort="${t.date}">${escapeHtml(t.date)}</td>
      <td>${escapeHtml(t.location)}</td>
      <td>${escapeHtml(t.source)}</td>
      <td class="numeric" data-sort="${t.participants}">${t.participants}</td>
      <td class="numeric" data-sort="${t.matches}">${t.matches}</td>
    </tr>`).join('\n');

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
</div>

<div id="players-tab" class="tab-panel active">
  <div id="count">${playerRows.length} unique players. Click a column header to sort.</div>
  <table data-sortable>
    <thead>
      <tr>
        <th data-type="string">Player</th>
        <th data-type="string">Location</th>
        <th data-type="string">Contact</th>
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
  <div id="count">${tournamentRows.length} tournaments. Click a column header to sort.</div>
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

<script src="index.js"></script>
</body>
</html>
`;

  fs.writeFileSync(path.join(REPO_ROOT, 'index.html'), html);
}

function main() {
  const players = new Map();
  const tournaments = [];
  processChallonge(players, tournaments);
  processStartgg(players, tournaments);

  const tournamentLocationByUrl = new Map(tournaments.map((t) => [t.url, t.location]));
  const playerRows = buildPlayerRows(players, tournamentLocationByUrl);

  writeCsv(playerRows);
  writeCss();
  writeJs();
  writeHtml(playerRows, tournaments);

  console.log(`Unique players: ${playerRows.length}`);
  console.log(`Tournaments: ${tournaments.length}`);
  console.log(`Output: ${path.join(__dirname, 'players.csv')}`);
  console.log(`Output: ${path.join(REPO_ROOT, 'index.html')}`);
  console.log(`Output: ${path.join(REPO_ROOT, 'index.css')}`);
  console.log(`Output: ${path.join(REPO_ROOT, 'index.js')}`);
}

main();
