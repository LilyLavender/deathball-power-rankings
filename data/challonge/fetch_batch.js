// Fetch a batch of Challonge tournaments listed in challonge.md and keep a
// single lookup file (challonge/tournaments.json) keyed by tournament URL,
// so each tournament's data lives at one address you can always get back to.
//
// Each tournament costs exactly 1 API call (participants + matches are
// included in the same request as the tournament info) and is only fetched
// once — already-fetched URLs are skipped on rerun, so the monthly request
// budget is only spent on tournaments that are new.
//
// Reads CHALLONGE_API_KEY from .env at the repo root (see fetch_tournament.js).
//
// Usage:
//   node fetch_batch.js [count] [offset]
// Example (first 5 tournaments in challonge.md):
//   node fetch_batch.js 5

const fs = require('fs');
const path = require('path');
const https = require('https');
const { resolveParticipantName } = require('./resolve_participant_name');

const DATA_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(__dirname, '..', '..');
const LIST_PATH = path.join(DATA_ROOT, 'tours-all-challonge.md');
const STORE_PATH = path.join(__dirname, 'tournaments.json');
const CSV_DIR = __dirname;

const count = parseInt(process.argv[2] || '5', 10);
const offset = parseInt(process.argv[3] || '0', 10);

const envPath = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
const apiKey = process.env.CHALLONGE_API_KEY;
if (!apiKey) {
  console.error('Missing CHALLONGE_API_KEY (set it in .env at the repo root, or export it)');
  process.exit(1);
}

const urlPattern = /^https?:\/\/(?:([\w-]+)\.)?challonge\.com\/([\w-]+)\/?$/;

function parseUrl(url) {
  const match = url.match(urlPattern);
  if (!match) return null;
  const [, subdomain, slug] = match;
  const tournamentId = subdomain ? `${subdomain}-${slug}` : slug;
  return { url, subdomain: subdomain || null, slug, tournamentId };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

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
  return [header, ...rows]
    .map((row) => row.map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v)).join(','))
    .join('\n');
}

async function main() {
  const allUrls = fs.readFileSync(LIST_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const store = fs.existsSync(STORE_PATH) ? JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) : {};

  const batch = allUrls.slice(offset, offset + count);
  let fetched = 0;
  let skipped = 0;

  for (const url of batch) {
    if (store[url]) {
      const tag = store[url].error ? `previously errored: ${store[url].error}` : 'already fetched';
      console.log(`skip (${tag}): ${url}`);
      skipped += 1;
      continue;
    }

    const parsed = parseUrl(url);
    if (!parsed) {
      console.error(`could not parse url, skipping: ${url}`);
      continue;
    }

    const apiUrl = `https://api.challonge.com/v1/tournaments/${parsed.tournamentId}.json?api_key=${apiKey}&include_participants=1&include_matches=1`;
    try {
      const data = await fetchJson(apiUrl);
      const t = data.tournament;

      store[url] = {
        url,
        tournament_id: parsed.tournamentId,
        fetched_at: new Date().toISOString(),
        tournament: t,
      };
      fetched += 1;

      const date = (t.started_at || t.created_at).slice(0, 10);
      const nameSlug = t.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const csvPath = path.join(CSV_DIR, `${date}_${nameSlug}.csv`);
      fs.writeFileSync(csvPath, toCsv(t));

      console.log(`fetched: ${url} -> ${t.name} (${t.participants.length}p, ${t.matches.length}m) -> ${csvPath}`);
    } catch (err) {
      store[url] = {
        url,
        tournament_id: parsed.tournamentId,
        fetched_at: new Date().toISOString(),
        error: err.message,
      };
      console.error(`failed: ${url} -> ${err.message}`);
    }
  }

  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 1));
  console.log(`\nDone. Fetched ${fetched}, skipped ${skipped} (already had data), store: ${STORE_PATH}`);
}

main();
