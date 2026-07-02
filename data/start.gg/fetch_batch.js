// Fetch start.gg tournaments listed in startgg.md via the start.gg GraphQL
// API and keep a single lookup file (start.gg/tournaments.json) keyed by
// the bracket URL, same pattern as challonge/tournaments.json.
//
// Each tournament/event is resolved to a numeric event id from its URL,
// then entrants + all sets are pulled in as few requests as possible
// (one request per page of sets, entrants included on the first page).
// Already-fetched URLs are skipped on rerun.
//
// Reads STARTGG_API_KEY from .env at the repo root.
//
// Usage:
//   node fetch_batch.js [count] [offset]

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(__dirname, '..', '..');
const LIST_PATH = path.join(DATA_ROOT, 'tours-all-startgg.md');
const STORE_PATH = path.join(__dirname, 'tournaments.json');
const CSV_DIR = __dirname;
const API_URL = 'https://api.start.gg/gql/alpha';

const count = parseInt(process.argv[2] || '1000', 10);
const offset = parseInt(process.argv[3] || '0', 10);

const envPath = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
const apiKey = process.env.STARTGG_API_KEY;
if (!apiKey) {
  console.error('Missing STARTGG_API_KEY (set it in .env at the repo root, or export it)');
  process.exit(1);
}

const urlPattern = /^https:\/\/(?:www\.)?start\.gg\/tournament\/([\w-]+)\/events\/([\w-]+)\//;

function parseUrl(url) {
  const match = url.match(urlPattern);
  if (!match) return null;
  const [, tournamentSlug, eventSlug] = match;
  return { tournamentSlug, eventSlug, apiSlug: `tournament/${tournamentSlug}/event/${eventSlug}` };
}

function graphql(query, variables) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        const parsed = JSON.parse(data);
        if (parsed.errors) {
          reject(new Error(JSON.stringify(parsed.errors).slice(0, 300)));
          return;
        }
        resolve(parsed.data);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const EVENT_META_QUERY = `query EventMeta($slug: String!) {
  event(slug: $slug) {
    id
    name
    tournament { id name startAt city addrState }
  }
}`;

const EVENT_PAGE_QUERY = `query EventPage($eventId: ID!, $entrantPage: Int!, $setPage: Int!) {
  event(id: $eventId) {
    entrants(query: { page: $entrantPage, perPage: 100 }) {
      pageInfo { totalPages }
      nodes {
        id
        name
        participants { id gamerTag prefix }
      }
    }
    sets(page: $setPage, perPage: 50, sortType: STANDARD) {
      pageInfo { totalPages }
      nodes {
        id
        identifier
        round
        winnerId
        slots {
          entrant { id }
          standing { stats { score { value } } }
        }
        games {
          selections { entrant { id } character { name } }
        }
      }
    }
  }
}`;

async function fetchAllPages(eventId) {
  const entrants = [];
  const sets = [];

  let entrantPage = 1;
  let entrantTotalPages = 1;
  let setPage = 1;
  let setTotalPages = 1;

  while (entrantPage <= entrantTotalPages || setPage <= setTotalPages) {
    const data = await graphql(EVENT_PAGE_QUERY, {
      eventId,
      entrantPage: Math.min(entrantPage, entrantTotalPages),
      setPage: Math.min(setPage, setTotalPages),
    });
    const ev = data.event;

    if (entrantPage <= entrantTotalPages) {
      entrants.push(...ev.entrants.nodes);
      entrantTotalPages = ev.entrants.pageInfo.totalPages;
      entrantPage += 1;
    }
    if (setPage <= setTotalPages) {
      sets.push(...ev.sets.nodes);
      setTotalPages = ev.sets.pageInfo.totalPages;
      setPage += 1;
    }
  }

  // de-dupe in case both loops re-fetched the same final page
  const uniqueEntrants = [...new Map(entrants.map((e) => [e.id, e])).values()];
  const uniqueSets = [...new Map(sets.map((s) => [s.id, s])).values()];
  return { entrants: uniqueEntrants, sets: uniqueSets };
}

// participants[0].gamerTag is the normal source, but entrants occasionally
// lack a participant gamerTag (e.g. unregistered/placeholder entrants) —
// fall back to the entrant's own name, which start.gg always populates.
function resolveEntrantName(e) {
  return e.participants[0]?.gamerTag || e.name || '';
}

function toCsv(entrants, sets) {
  const entrantById = new Map(entrants.map((e) => [e.id, { ...(e.participants[0] || {}), gamerTag: resolveEntrantName(e) }]));

  const header = [
    'Match Identifier', 'Top Player Prefix', 'Top Player Name', 'Top Player Stocks',
    'Top Player Character', 'Top Player Character IDs', 'Top Player DQ',
    'Bottom Player Prefix', 'Bottom Player Name', 'Bottom Player Stocks',
    'Bottom Player Character', 'Bottom Player Character IDs', 'Bottom Player DQ',
  ];

  const rows = sets.filter((s) => s.slots.length === 2 && s.slots.every((sl) => sl.entrant)).map((s) => {
    const [topSlot, bottomSlot] = s.slots;
    const topPlayer = entrantById.get(topSlot.entrant.id) || {};
    const bottomPlayer = entrantById.get(bottomSlot.entrant.id) || {};

    const topRawScore = topSlot.standing?.stats?.score?.value;
    const bottomRawScore = bottomSlot.standing?.stats?.score?.value;
    const topDq = topRawScore === -1;
    const bottomDq = bottomRawScore === -1;
    const topScore = topDq || topRawScore == null ? 0 : topRawScore;
    const bottomScore = bottomDq || bottomRawScore == null ? 0 : bottomRawScore;

    const topChar = (s.games || []).find((g) => g.selections?.some((sel) => sel.entrant.id === topSlot.entrant.id))
      ?.selections.find((sel) => sel.entrant.id === topSlot.entrant.id)?.character?.name || '';
    const bottomChar = (s.games || []).find((g) => g.selections?.some((sel) => sel.entrant.id === bottomSlot.entrant.id))
      ?.selections.find((sel) => sel.entrant.id === bottomSlot.entrant.id)?.character?.name || '';

    return [
      s.identifier || s.id, topPlayer.prefix || '', topPlayer.gamerTag || '', topScore, topChar, '', topDq,
      bottomPlayer.prefix || '', bottomPlayer.gamerTag || '', bottomScore, bottomChar, '', bottomDq,
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
      console.log(`skip (${store[url].error ? 'previously errored' : 'already fetched'}): ${url}`);
      skipped += 1;
      continue;
    }

    const parsed = parseUrl(url);
    if (!parsed) {
      console.error(`could not parse url, skipping: ${url}`);
      continue;
    }

    try {
      const meta = await graphql(EVENT_META_QUERY, { slug: parsed.apiSlug });
      const ev = meta.event;
      if (!ev) throw new Error('event not found');

      const { entrants, sets } = await fetchAllPages(ev.id);

      store[url] = {
        url,
        event_id: ev.id,
        tournament_id: ev.tournament.id,
        fetched_at: new Date().toISOString(),
        tournament: ev.tournament,
        event: { id: ev.id, name: ev.name },
        entrants,
        sets,
      };
      fetched += 1;

      const date = new Date(ev.tournament.startAt * 1000).toISOString().slice(0, 10);
      const nameSlug = ev.tournament.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const locSlug = [ev.tournament.city, ev.tournament.addrState]
        .filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const csvPath = path.join(CSV_DIR, `${date}_${nameSlug}${locSlug ? `_${locSlug}` : ''}.csv`);
      fs.writeFileSync(csvPath, toCsv(entrants, sets));

      console.log(`fetched: ${url} -> ${ev.tournament.name} (${entrants.length}p, ${sets.length}m) -> ${csvPath}`);
    } catch (err) {
      store[url] = { url, fetched_at: new Date().toISOString(), error: err.message };
      console.error(`failed: ${url} -> ${err.message}`);
    }

    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 1));
  }

  console.log(`\nDone. Fetched ${fetched}, skipped ${skipped}, store: ${STORE_PATH}`);
}

main();
