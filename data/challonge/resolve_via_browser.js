// For tournaments that 404 by slug on the Challonge v1 API (this happens
// for multi-owner tournaments, where the slug-based lookup is broken but
// the numeric tournament ID still works), use an already-running Chrome
// instance (remote debugging) to load the public bracket page, read the
// real numeric tournament ID out of window._initialStoreState, then refetch
// via the API using that ID.
//
// Requires Chrome already running with --remote-debugging-port=9222.
//
// Usage:
//   node resolve_via_browser.js

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STORE_PATH = path.join(__dirname, 'tournaments.json');
const CSV_DIR = __dirname;
const CDP_BASE = 'http://localhost:9222';

const envPath = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
const apiKey = process.env.CHALLONGE_API_KEY;
if (!apiKey) {
  console.error('Missing CHALLONGE_API_KEY');
  process.exit(1);
}

function cdpJson(pathname) {
  return new Promise((resolve, reject) => {
    require('http').get(`${CDP_BASE}${pathname}`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

function wsCall(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 1e9);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id, method, params })));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.close();
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    ws.addEventListener('error', reject);
    setTimeout(() => reject(new Error('CDP call timed out')), 15000);
  });
}

async function resolveTournamentId(url) {
  const { targetId } = await wsCall(
    (await cdpJson('/json/version')).webSocketDebuggerUrl,
    'Target.createTarget',
    { url }
  );
  const { targetInfos } = await cdpJson('/json').then((pages) => ({ targetInfos: pages }));
  const page = targetInfos.find((p) => p.id === targetId) || (await cdpJson('/json')).find((p) => p.id === targetId);

  // give the page time to pass the Cloudflare challenge and render
  await new Promise((r) => setTimeout(r, 4000));

  const pages = await cdpJson('/json');
  const target = pages.find((p) => p.id === targetId);
  if (!target) throw new Error('target disappeared');

  const result = await wsCall(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: 'JSON.stringify(window._initialStoreState && window._initialStoreState.TournamentStore && window._initialStoreState.TournamentStore.tournament && window._initialStoreState.TournamentStore.tournament.id || null)',
    returnByValue: true,
  });

  await wsCall(
    (await cdpJson('/json/version')).webSocketDebuggerUrl,
    'Target.closeTarget',
    { targetId }
  );

  const id = JSON.parse(result.result.value);
  return id;
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
  const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  const errored = Object.entries(store).filter(([, rec]) => rec.error);

  console.log(`${errored.length} previously-errored tournaments to retry via browser resolution`);

  let recovered = 0;
  let stillFailed = 0;

  for (const [url, oldRec] of errored) {
    try {
      const tournamentId = await resolveTournamentId(url);
      if (!tournamentId) throw new Error('could not find numeric tournament id on page');

      const apiUrl = `https://api.challonge.com/v1/tournaments/${tournamentId}.json?api_key=${apiKey}&include_participants=1&include_matches=1`;
      const data = await fetchJson(apiUrl);
      const t = data.tournament;

      store[url] = {
        url,
        tournament_id: String(tournamentId),
        resolved_via: 'browser',
        // Browser-resolved tournaments bypass fetch_batch.js's own
        // before/after diff (add_tournaments.js's normal "was this newly
        // fetched this run" check), so they'd otherwise never surface for
        // the interactive player/location prompts. This flag tells
        // add_tournaments.js to treat it as new exactly once; it clears the
        // flag itself after walking the tournament's prompts.
        dedupPending: true,
        fetched_at: new Date().toISOString(),
        tournament: t,
      };

      const date = (t.started_at || t.created_at).slice(0, 10);
      const nameSlug = t.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const csvPath = path.join(CSV_DIR, `${date}_${nameSlug}.csv`);
      fs.writeFileSync(csvPath, toCsv(t));

      console.log(`recovered: ${url} -> ${t.name} (id ${tournamentId}, ${t.participants.length}p, ${t.matches.length}m) -> ${csvPath}`);
      recovered += 1;
    } catch (err) {
      console.error(`still failed: ${url} -> ${err.message}`);
      store[url] = { ...oldRec, browser_resolution_error: err.message };
      stillFailed += 1;
    }

    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 1));
  }

  console.log(`\nDone. Recovered ${recovered}, still failed ${stillFailed}`);
}

main();
