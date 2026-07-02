// Rewrite all per-tournament CSVs from the cached tournaments.json store,
// without spending any API calls. Useful after fixing a CSV-generation bug.
//
// Usage:
//   node regenerate_csvs.js

const fs = require('fs');
const path = require('path');
const { resolveParticipantName } = require('./resolve_participant_name');

const STORE_PATH = path.join(__dirname, 'tournaments.json');
const CSV_DIR = __dirname;

function toCsv(t) {
  const nameById = new Map(t.participants.map((p) => [p.participant.id, resolveParticipantName(p.participant)]));
  const header = [
    'Match Identifier', 'Top Player Prefix', 'Top Player Name', 'Top Player Stocks',
    'Top Player Character', 'Top Player Character IDs', 'Top Player DQ',
    'Bottom Player Prefix', 'Bottom Player Name', 'Bottom Player Stocks',
    'Bottom Player Character', 'Bottom Player Character IDs', 'Bottom Player DQ',
  ];
  const rows = t.matches.map((m) => {
    const mm = m.match;
    let [topScore, bottomScore] = (mm.scores_csv || '').split('-').map((s) => s.trim());

    if (topScore === bottomScore && mm.winner_id) {
      topScore = mm.winner_id === mm.player1_id ? '1' : '0';
      bottomScore = mm.winner_id === mm.player2_id ? '1' : '0';
    }

    const topName = nameById.get(mm.player1_id) || '';
    const bottomName = nameById.get(mm.player2_id) || '';
    const topDq = mm.forfeited === true && mm.loser_id === mm.player1_id;
    const bottomDq = mm.forfeited === true && mm.loser_id === mm.player2_id;
    return [
      mm.identifier || mm.id, '', topName, topScore ?? '', '', '', topDq,
      '', bottomName, bottomScore ?? '', '', '', bottomDq,
    ];
  });
  return [header, ...rows]
    .map((row) => row.map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v)).join(','))
    .join('\n');
}

const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
let written = 0;

for (const entry of Object.values(store)) {
  const t = entry.tournament;
  if (!t) continue;

  const date = (t.started_at || t.created_at).slice(0, 10);
  const nameSlug = t.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const csvPath = path.join(CSV_DIR, `${date}_${nameSlug}.csv`);
  fs.writeFileSync(csvPath, toCsv(t));
  written += 1;
}

console.log(`Rewrote ${written} CSVs in ${CSV_DIR}`);
