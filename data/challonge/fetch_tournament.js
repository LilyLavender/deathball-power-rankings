// Fetch a Challonge tournament (info + participants + matches) and write:
//   challonge/_raw/<slug>.json        - raw API response
//   challonge/<date>_<slug>.csv       - match list in the start.gg CSV schema
//
// Reads CHALLONGE_API_KEY from the environment, or from a .env file at the
// repo root (CHALLONGE_API_KEY=xxx), so the key never needs to be typed on
// the command line.
//
// Usage:
//   node fetch_tournament.js <subdomain> <tournament-slug>
// Example:
//   node fetch_tournament.js fpaplayers puf4t590

const fs = require('fs');
const path = require('path');
const https = require('https');

const [subdomain, slug] = process.argv.slice(2);

const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
const apiKey = process.env.CHALLONGE_API_KEY;

if (!subdomain || !slug) {
  console.error('Usage: node fetch_tournament.js <subdomain> <tournament-slug>');
  process.exit(1);
}
if (!apiKey) {
  console.error('Missing CHALLONGE_API_KEY (set it in .env at the repo root, or export it)');
  process.exit(1);
}

const tournamentId = `${subdomain}-${slug}`;
const url = `https://api.challonge.com/v1/tournaments/${tournamentId}.json?api_key=${apiKey}&include_participants=1&include_matches=1`;

https.get(url, (res) => {
  let body = '';
  res.on('data', (chunk) => (body += chunk));
  res.on('end', () => {
    if (res.statusCode !== 200) {
      console.error(`Challonge API error ${res.statusCode}: ${body.slice(0, 200)}`);
      process.exit(1);
    }

    const data = JSON.parse(body);
    const t = data.tournament;

    const rawDir = path.join(__dirname, '_raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, `${slug}.json`), JSON.stringify(data, null, 1));

    const nameById = new Map(t.participants.map((p) => [p.participant.id, p.participant.name]));

    const header = [
      'Match Identifier', 'Top Player Prefix', 'Top Player Name', 'Top Player Stocks',
      'Top Player Character', 'Top Player Character IDs', 'Top Player DQ',
      'Bottom Player Prefix', 'Bottom Player Name', 'Bottom Player Stocks',
      'Bottom Player Character', 'Bottom Player Character IDs', 'Bottom Player DQ',
    ];

    const rows = t.matches.map((m) => {
      const mm = m.match;
      let [topScore, bottomScore] = (mm.scores_csv || '').split('-').map((s) => s.trim());

      // Untracked-score matches report "0-0" (or nothing), which is
      // indistinguishable from a real 0-0 result. winner_id/loser_id are
      // still set in that case, so fall back to those to pick a winner.
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

    const csv = [header, ...rows]
      .map((row) => row.map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v)).join(','))
      .join('\n');

    const date = (t.started_at || t.created_at).slice(0, 10);
    const nameSlug = t.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const csvPath = path.join(__dirname, `${date}_${nameSlug}.csv`);
    fs.writeFileSync(csvPath, csv);

    console.log(`Tournament: ${t.name} (${t.state}, ${t.tournament_type})`);
    console.log(`Participants: ${t.participants.length}, Matches: ${t.matches.length}`);
    console.log(`Raw JSON: ${path.join(rawDir, `${slug}.json`)}`);
    console.log(`CSV: ${csvPath}`);
  });
}).on('error', (err) => {
  console.error(err);
  process.exit(1);
});
