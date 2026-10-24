// Imports a hand-transcribed ("paper") tournament -- a bracket sheet photo,
// a whiteboard, a results post -- into data/paper/tournaments.json, the third
// tournament store next to challonge/ and start.gg/. Nothing is fetched: you
// type (or hand over a JSON file with) the roster and results, point at the
// image(s) of the source, and say where the results came from.
//
// Usage:
//   node data/paper/add_paper_tournament.js <entry.json>   import a prepared record
//   node data/paper/add_paper_tournament.js                interactive wizard
//   ... --no-dedupe    just write the record; don't run add_tournaments.js after
//   ... --replace      overwrite an existing record with the same key
//
// Entry JSON (every field but name/date and one of participants/matches is
// optional):
//   {
//     "name": "Up-Down Paper Bracket",
//     "date": "2018-05-12",
//     "city": "Minneapolis", "state": "MN", "location": "Up-Down",
//     "type": "double elimination",      // or "single elimination" / "round robin" / "swiss"
//     "source": { "link": "https://...", "note": "Photo of the sheet, from X" },  // one or both
//     "images": ["C:/photos/bracket.jpg", { "file": "C:/photos/back.jpg", "caption": "Losers side" }],
//     "participants": ["Alice", { "name": "Bob", "seed": 2, "placement": 1 }],
//     "matches": [
//       { "p1": "Alice", "p2": "Bob", "score": "2-1", "round": 1 },         // p1-p2 set score
//       { "p1": "Alice", "p2": "Carl", "games": ["3-1", "3-2"], "round": 2 }, // per-game goals
//       { "p1": "Alice", "p2": "Dan", "dq": true, "round": -1 }              // p2 forfeited to p1
//     ],
//     "key": "optional-custom-slug"      // defaults to <name slug>-<date>
//   }
//   Matches use manual-matches.json's entry shape (p1/p2 + score|games|dq;
//   no score = plain win for p1). `round` follows the site's convention:
//   positive = winners bracket round, negative = losers bracket round. For
//   a single/double-elimination event you can leave rounds off entirely:
//   list the matches in the order they were played and collectPaper()
//   (aggregate_players.js, see inferPaperRounds) works the rounds out from
//   who went on to play whom, so the page still draws the bracket. Set a
//   round on any match and inference is skipped for the whole record, so
//   either place every match by hand or none. A `placement` on a
//   participant is the sheet's own final placing and wins over anything
//   derived from the matches.
//
// What it does:
//   1. Copies each image into data/paper/images/ (named after the record
//      key) and records the copies' filenames -- the site serves them from
//      there directly, so keep that folder in the repo.
//   2. Writes the record under a synthetic "paper://<key>" URL. Every
//      URL-keyed config (tournament-locations.json, tournament-groups.json,
//      tournament-doubles.json, manual-matches.json, tournament-videos.json)
//      works against that URL exactly as it does for a Challonge one.
//      City/state/venue are stored on the record itself; a
//      tournament-locations.json entry for the URL still overrides them.
//   3. Writes the tournament's CSV in the shared schema next to the other
//      sources' per-tournament CSVs (data/paper/<date>_<key>.csv).
//   4. Flags the record dedupPending and runs add_tournaments.js, which
//      walks the new names through the usual alias/split confirmation and
//      then regenerates the site. (--no-dedupe skips this step; the flag
//      stays set so the next add_tournaments.js run picks it up.)

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const readline = require('node:readline/promises');
const { slugify } = require('../slugify');

const DATA_ROOT = path.join(__dirname, '..');
const STORE_PATH = path.join(__dirname, 'tournaments.json');
const IMAGES_DIR = path.join(__dirname, 'images');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic']);

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const entryPath = args.find((a) => !a.startsWith('--')) || null;

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// --- Validation / normalisation ---

const TYPES = {
  s: 'single elimination', single: 'single elimination', 'single elimination': 'single elimination',
  d: 'double elimination', double: 'double elimination', 'double elimination': 'double elimination',
  rr: 'round robin', 'round robin': 'round robin', 'round-robin': 'round robin',
  sw: 'swiss', swiss: 'swiss',
};

function normalizeEntry(raw) {
  const e = { ...raw };
  e.name = String(e.name || '').trim();
  if (!e.name) fail('"name" is required');
  e.date = String(e.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) fail(`"date" must be YYYY-MM-DD (got "${e.date}")`);

  if (e.type != null && e.type !== '') {
    const t = TYPES[String(e.type).trim().toLowerCase()];
    if (!t) fail(`unknown "type" "${e.type}" (use single elimination / double elimination / round robin / swiss)`);
    e.type = t;
  } else {
    delete e.type;
  }

  e.participants = (e.participants || []).map((p) => {
    const entry = typeof p === 'string' ? { name: p } : { ...p };
    entry.name = String(entry.name || '').trim();
    if (!entry.name) fail('a participant is missing its name');
    if (entry.seed != null) entry.seed = Number(entry.seed);
    if (entry.placement != null) entry.placement = Number(entry.placement);
    return Object.keys(entry).length === 1 ? entry.name : entry;
  });

  e.matches = (e.matches || []).map((m, i) => {
    const match = { ...m };
    match.p1 = String(match.p1 || '').trim();
    match.p2 = String(match.p2 || '').trim();
    if (!match.p1 || !match.p2) fail(`match #${i + 1} needs both "p1" and "p2"`);
    if (match.score != null && !/^\d+-\d+$/.test(String(match.score))) fail(`match #${i + 1}: "score" must look like "2-1"`);
    if (match.games != null && (!Array.isArray(match.games) || match.games.some((g) => !/^\d+-\d+$/.test(String(g))))) {
      fail(`match #${i + 1}: "games" must be an array of "3-2" style goal scores`);
    }
    if (match.round != null) match.round = Number(match.round);
    return match;
  });

  if (!e.participants.length && !e.matches.length) fail('give at least a "participants" list or a "matches" list');

  if (e.source && typeof e.source === 'string') {
    e.source = /^https?:\/\//i.test(e.source) ? { link: e.source } : { note: e.source };
  }
  if (e.source) {
    const src = {};
    if (e.source.link) src.link = String(e.source.link).trim();
    if (e.source.note) src.note = String(e.source.note).trim();
    if (Object.keys(src).length) e.source = src; else delete e.source;
  }

  e.images = (e.images || []).map((img) => (typeof img === 'string' ? { file: img } : { ...img }))
    .filter((img) => img.file);
  for (const img of e.images) {
    img.file = path.resolve(String(img.file).trim().replace(/^["']|["']$/g, ''));
    if (!fs.existsSync(img.file)) fail(`image not found: ${img.file}`);
    if (!IMAGE_EXTS.has(path.extname(img.file).toLowerCase())) fail(`not an image file: ${img.file}`);
  }

  for (const k of ['city', 'state', 'location', 'country']) {
    if (e[k] != null && String(e[k]).trim()) e[k] = String(e[k]).trim(); else delete e[k];
  }

  e.key = slugify(String(e.key || `${e.name}-${e.date}`).trim());
  if (!e.key) fail('could not build a key from the name/date');
  return e;
}

// --- Interactive wizard ---

async function ask(rl, q) {
  return (await rl.question(q)).trim();
}

// "W2: Alice 2-1 Bob", "L1: Carl > Dan", "GF: Alice beat Bob", "Alice dq Bob"
const MATCH_LINE = /^(?:(W|L|R|GF|GFR)\s*(\d*)\s*:\s*)?(.+?)\s+(\d+-\d+|>|beat|def\.?|dq)\s+(.+)$/i;

function parseMatchLine(line) {
  const m = MATCH_LINE.exec(line);
  if (!m) return null;
  const [, roundKind, roundNum, p1, result, p2] = m;
  const match = { p1: p1.trim(), p2: p2.trim() };
  const r = result.toLowerCase();
  if (/^\d+-\d+$/.test(r)) match.score = r;
  else if (r === 'dq') match.dq = true;
  if (roundKind) {
    const kind = roundKind.toUpperCase();
    const n = roundNum ? Number(roundNum) : 1;
    if (kind === 'L') match.round = -n;
    else if (kind === 'GF') match.round = 'GF';
    else if (kind === 'GFR') match.round = 'GFR';
    else match.round = n;
  }
  return match;
}

// A grand final typed as "GF:" / "GFR:" sits after the last winners round.
function resolveGrandFinals(matches) {
  const maxWinners = Math.max(0, ...matches.map((m) => (typeof m.round === 'number' && m.round > 0 ? m.round : 0)));
  for (const m of matches) {
    if (m.round === 'GF') m.round = maxWinners + 1;
    else if (m.round === 'GFR') m.round = maxWinners + 2;
  }
}

async function wizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Paper tournament import. Blank = skip for optional fields.\n');
    const e = {};
    e.name = await ask(rl, 'Tournament name: ');
    e.date = await ask(rl, 'Date (YYYY-MM-DD): ');
    e.city = await ask(rl, 'City: ');
    e.state = await ask(rl, 'State/Province abbreviation: ');
    e.location = await ask(rl, 'Venue: ');
    e.type = await ask(rl, 'Format [s = single elim / d = double elim / rr = round robin / sw = swiss]: ');
    const link = await ask(rl, 'Source link (URL, if any): ');
    const note = await ask(rl, 'Source note (who/where the results came from, if not a link): ');
    e.source = { link, note };
    const imgs = await ask(rl, 'Image file path(s), comma-separated: ');
    e.images = imgs ? imgs.split(',').map((s) => s.trim()).filter(Boolean) : [];

    console.log('\nParticipants, one per line as "Name" or "Name, seed, placement" (blank line to finish):');
    e.participants = [];
    for (;;) {
      const line = await ask(rl, '  > ');
      if (!line) break;
      const [name, seed, placement] = line.split(',').map((s) => s.trim());
      const p = { name };
      if (seed) p.seed = Number(seed);
      if (placement) p.placement = Number(placement);
      e.participants.push(p);
    }

    console.log('\nMatches, one per line, winner first (blank line to finish). Examples:');
    console.log('  Alice 2-1 Bob        set score');
    console.log('  Alice > Bob          plain win (no score recorded)');
    console.log('  Alice dq Bob         Bob forfeited');
    console.log('  W2: Alice 2-0 Bob    winners round 2;  L1: = losers round 1;  GF: / GFR: = grand final / reset');
    e.matches = [];
    for (;;) {
      const line = await ask(rl, '  > ');
      if (!line) break;
      const m = parseMatchLine(line);
      if (!m) { console.log('    could not parse that line, try again'); continue; }
      e.matches.push(m);
    }
    resolveGrandFinals(e.matches);
    return e;
  } finally {
    rl.close();
  }
}

// --- Output ---

// tournaments.json layout: one compact object per participant/match line,
// everything else pretty-printed -- so a record stays hand-editable (and a
// one-score fix stays a one-line diff) instead of exploding to one key per
// line. add_tournaments.js uses this too when it clears dedupPending.
function serializePaperStore(store) {
  const compact = (v) => JSON.stringify(v);
  const lines = ['{'];
  const urls = Object.keys(store);
  urls.forEach((url, ui) => {
    const rec = store[url];
    lines.push(`  ${compact(url)}: {`);
    const keys = Object.keys(rec);
    keys.forEach((k, ki) => {
      const comma = ki < keys.length - 1 ? ',' : '';
      const v = rec[k];
      if ((k === 'participants' || k === 'matches' || k === 'images') && Array.isArray(v)) {
        if (!v.length) { lines.push(`    ${compact(k)}: []${comma}`); return; }
        lines.push(`    ${compact(k)}: [`);
        v.forEach((item, i) => lines.push(`      ${compact(item)}${i < v.length - 1 ? ',' : ''}`));
        lines.push(`    ]${comma}`);
      } else {
        lines.push(`    ${compact(k)}: ${compact(v)}${comma}`);
      }
    });
    lines.push(`  }${ui < urls.length - 1 ? ',' : ''}`);
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}

function csvFor(entry, record) {
  const header = [
    'Match Identifier', 'Top Player Prefix', 'Top Player Name', 'Top Player Stocks',
    'Top Player Character', 'Top Player Character IDs', 'Top Player DQ',
    'Bottom Player Prefix', 'Bottom Player Name', 'Bottom Player Stocks',
    'Bottom Player Character', 'Bottom Player Character IDs', 'Bottom Player DQ',
  ];
  const rows = record.matches.map((m, i) => {
    let top = '';
    let bottom = '';
    if (m.score) [top, bottom] = m.score.split('-');
    else if (m.games) {
      const wins = m.games.reduce((acc, g) => { const [a, b] = g.split('-').map(Number); return a > b ? [acc[0] + 1, acc[1]] : [acc[0], acc[1] + 1]; }, [0, 0]);
      [top, bottom] = wins;
    } else if (!m.dq) { top = 1; bottom = 0; }
    return [m.identifier != null ? m.identifier : i + 1, '', m.p1, top, '', '', false, '', m.p2, bottom, '', '', m.dq === true];
  });
  return [header, ...rows]
    .map((row) => row.map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v)).join(','))
    .join('\n');
}

async function main() {
  const raw = entryPath ? readJson(path.resolve(entryPath), null) : await wizard();
  if (!raw) fail(`could not read ${entryPath}`);
  const entry = normalizeEntry(raw);
  const url = `paper://${entry.key}`;

  const store = readJson(STORE_PATH, {});
  if (store[url] && !flags.has('--replace')) {
    fail(`${url} already exists in ${path.relative(process.cwd(), STORE_PATH)} (pass --replace to overwrite it)`);
  }

  // Copy images in, named after the record so the folder stays browsable.
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const images = entry.images.map((img, i) => {
    const ext = path.extname(img.file).toLowerCase();
    const file = `${entry.key}${entry.images.length > 1 ? `-${i + 1}` : ''}${ext}`;
    fs.copyFileSync(img.file, path.join(IMAGES_DIR, file));
    return img.caption ? { file, caption: img.caption } : file;
  });

  const record = {
    name: entry.name,
    date: entry.date,
  };
  for (const k of ['city', 'state', 'country', 'location', 'type', 'source']) if (entry[k] != null) record[k] = entry[k];
  record.images = images;
  record.participants = entry.participants;
  record.matches = entry.matches;
  record.dedupPending = true;

  store[url] = record;
  fs.writeFileSync(STORE_PATH, serializePaperStore(store));

  // Same "<date>_<name slug>.csv" naming as the scraped sources' CSVs.
  const csvName = `${entry.date}_${slugify(entry.name)}.csv`;
  fs.writeFileSync(path.join(__dirname, csvName), csvFor(entry, record) + '\n');

  console.log(`\nWrote ${url}`);
  console.log(`  ${record.participants.length} participant(s), ${record.matches.length} match(es), ${images.length} image(s)`);
  console.log(`  CSV: data/paper/${csvName}`);

  if (flags.has('--no-dedupe')) {
    console.log('\nSkipping dedupe (--no-dedupe). Run add_tournaments.js to walk its player names and regenerate the site.');
    return;
  }
  console.log('\nRunning add_tournaments.js to resolve its player names and regenerate the site...\n');
  execFileSync('node', [path.join(DATA_ROOT, 'players', 'add_tournaments.js')], { stdio: 'inherit' });
}

module.exports = { serializePaperStore, STORE_PATH };

if (require.main === module) main().catch((err) => fail(err.message));
