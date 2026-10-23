// Writes compare.html (repo root): a side-by-side comparison of up to four
// players, rendered entirely client-side from the JSON payload that
// aggregate_players.js's buildCompareData() produces (see the field layout
// notes above that function). The page is deliberately not in the main nav;
// player pages are the only way in ("Compare to..." tile plus the per-opponent
// compare icons on Match Statistics tiles), with the selection mirrored into
// the URL as ?p=slug-a,slug-b so a comparison can be shared.
//
// Kept separate from aggregate_players.js (same reasoning as
// generate_output.js/build_bracket.js) and written to take plain data +
// pre-rendered head/footer strings rather than requiring aggregate_players.js
// back, which would be a circular require.
//
// CLIENT_JS below is a String.raw literal so regex escapes survive untouched,
// which also means it must not contain a backtick or a "${" sequence.
const fs = require('fs');
const { stripCommentsInHeadBlocks } = require('./generate_output');

const CLIENT_JS = String.raw`(function () {
  var DATA = JSON.parse(document.getElementById('compare-data').textContent);
  var PLAYERS = DATA.players;
  var TOURNAMENTS = DATA.tournaments;
  var MAX_PLAYERS = 4;
  // Per-column accent, assigned by slot position (not by the player's own
  // card color) so every selected player is always visually distinct.
  var COLORS = ['#3eff8b', '#b04fff', '#ffd84d', '#4da6ff'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  var selected = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function flagImg(f) {
    if (!f) return '';
    return '<img class="loc-flag" src="' + esc(f.src) + '" title="' + esc(f.title) + '" alt="' + esc(f.title) + '">';
  }
  function playerHref(slug) { return 'players/' + encodeURIComponent(slug) + '.html'; }
  function tourneyHref(slug) { return 'tournaments/' + encodeURIComponent(slug) + '.html'; }
  function playerLink(slug, name) {
    if (!slug || !PLAYERS[slug]) return esc(name);
    return '<a href="' + playerHref(slug) + '">' + esc(name) + '</a>';
  }
  // Formats a bare YYYY-MM-DD from its own digits (never via Date parsing,
  // which would shift it a day in US timezones).
  function formatDateHuman(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1];
  }
  function pct(x) { return (x * 100).toFixed(0) + '%'; }
  function dim(s) { return ' <span class="h2h-record-dim">' + s + '</span>'; }
  function signed(n) { return (n > 0 ? '+' : '') + n; }

  // --- URL state -------------------------------------------------------
  function readSelectionFromUrl() {
    var m = /[?&]p=([^&]*)/.exec(location.search);
    if (!m) return [];
    var out = [];
    decodeURIComponent(m[1]).split(',').forEach(function (slug) {
      if (PLAYERS[slug] && out.indexOf(slug) < 0 && out.length < MAX_PLAYERS) out.push(slug);
    });
    return out;
  }
  function writeSelectionToUrl() {
    var url = location.pathname + (selected.length ? '?p=' + selected.map(encodeURIComponent).join(',') : '');
    history.replaceState(null, '', url);
  }

  // --- Picker ----------------------------------------------------------
  var picker = document.getElementById('compare-picker');
  var hint = document.getElementById('compare-hint');
  var sections = document.getElementById('compare-sections');

  function renderPicker(focusSearch) {
    var html = '';
    selected.forEach(function (slug, i) {
      var p = PLAYERS[slug];
      html += '<span class="compare-chip" style="--chip-color:' + COLORS[i] + '">' +
        '<span class="compare-chip-dot"></span>' +
        flagImg(p.f) + '<a href="' + playerHref(slug) + '">' + esc(p.n) + '</a>' +
        '<button type="button" class="compare-chip-remove" data-slug="' + esc(slug) + '" aria-label="Remove ' + esc(p.n) + '">&times;</button>' +
        '</span>';
    });
    if (selected.length < MAX_PLAYERS) {
      html += '<span class="compare-search-wrap">' +
        '<input type="text" class="compare-search" id="compare-search" placeholder="' + (selected.length ? 'Add another player...' : 'Search for a player...') + '" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="compare-search-list" aria-autocomplete="list">' +
        '<div class="compare-ac-list" id="compare-search-list" role="listbox"></div>' +
        '</span>';
    }
    picker.innerHTML = html;
    picker.querySelectorAll('.compare-chip-remove').forEach(function (btn) {
      btn.addEventListener('click', function () { removePlayer(btn.dataset.slug); });
    });
    var input = document.getElementById('compare-search');
    if (input) {
      wireSearch(input, document.getElementById('compare-search-list'));
      if (focusSearch) input.focus();
    }
  }

  function searchPlayers(query) {
    var q = query.trim().toLowerCase();
    if (!q) return [];
    var results = [];
    Object.keys(PLAYERS).forEach(function (slug) {
      if (selected.indexOf(slug) >= 0) return;
      var p = PLAYERS[slug];
      var name = p.n.toLowerCase();
      var tier;
      if (name.indexOf(q) === 0) tier = 0;
      else if (name.indexOf(q) >= 0) tier = 1;
      else if ((p.al || []).some(function (a) { return a.toLowerCase().indexOf(q) >= 0; })) tier = 2;
      else return;
      results.push({ slug: slug, p: p, tier: tier });
    });
    results.sort(function (a, b) { return a.tier - b.tier || (b.p.g - a.p.g) || a.p.n.localeCompare(b.p.n); });
    return results.slice(0, 10);
  }

  function wireSearch(input, list) {
    var activeIdx = -1;
    var current = [];
    function close() {
      list.innerHTML = '';
      list.classList.remove('visible');
      input.setAttribute('aria-expanded', 'false');
      activeIdx = -1;
      current = [];
    }
    function setActive(idx) {
      activeIdx = idx;
      list.querySelectorAll('.compare-ac-item').forEach(function (el, i) {
        el.classList.toggle('is-active', i === idx);
        if (i === idx) el.scrollIntoView({ block: 'nearest' });
      });
    }
    function open() {
      current = searchPlayers(input.value);
      if (!current.length) { close(); return; }
      list.innerHTML = current.map(function (r, i) {
        var meta = [r.p.loc, r.p.g + ' game' + (r.p.g === 1 ? '' : 's')].filter(Boolean).join(' &middot; ');
        return '<div class="compare-ac-item" role="option" data-idx="' + i + '">' +
          '<span class="compare-ac-name">' + flagImg(r.p.f) + esc(r.p.n) + '</span>' +
          '<span class="compare-ac-meta">' + meta + '</span>' +
          '</div>';
      }).join('');
      list.classList.add('visible');
      input.setAttribute('aria-expanded', 'true');
      list.querySelectorAll('.compare-ac-item').forEach(function (el) {
        // mousedown (not click) so it wins the race against the input's blur
        el.addEventListener('mousedown', function (e) { e.preventDefault(); addPlayer(current[Number(el.dataset.idx)].slug); });
        el.addEventListener('mousemove', function () { setActive(Number(el.dataset.idx)); });
      });
      setActive(0);
    }
    input.addEventListener('input', open);
    input.addEventListener('focus', function () { if (input.value.trim()) open(); });
    input.addEventListener('blur', close);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!current.length) { open(); return; }
        setActive(Math.min(activeIdx + 1, current.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (current.length) setActive(Math.max(activeIdx - 1, 0));
      } else if (e.key === 'Enter') {
        if (current.length) { e.preventDefault(); addPlayer(current[Math.max(activeIdx, 0)].slug); }
      } else if (e.key === 'Escape') {
        if (current.length) { e.preventDefault(); close(); } else { input.value = ''; }
      }
    });
  }

  function addPlayer(slug) {
    if (!PLAYERS[slug] || selected.indexOf(slug) >= 0 || selected.length >= MAX_PLAYERS) return;
    selected.push(slug);
    update(true);
  }
  function removePlayer(slug) {
    selected = selected.filter(function (s) { return s !== slug; });
    update(false);
  }

  // --- Stats table -----------------------------------------------------
  // Each row: label; cell(p) -> HTML (null renders as an em dash); num(p)
  // -> comparable number or null; dir: 1 = higher is better, -1 = lower is
  // better, 0 = no best-value highlight. Singles-only stats return null for
  // doubles-only players, same as their player page shows none of them.
  function singles(fn) { return function (p) { return p.do ? null : fn(p); }; }
  function rateCell(count, total) { return total ? count + '/' + total + dim('(' + pct(count / total) + ')') : null; }
  // Unlike the player page (which shows an em dash for zero), a zero count
  // is rendered here: in a comparison "0 upset losses" is a real, and often
  // the best, value, and the highlight needs a visible cell to land on.
  function tierCell(count, major, showTier) {
    if (!count) return '0';
    var s = '&times;' + count;
    if (showTier) {
      s += dim('(150+)');
      if (major) s += dim('&middot; ' + major + ' (200+)');
    }
    return s;
  }
  function oppCell(e, metric) { return e ? playerLink(e.s, e.n) + ' <span class="h2h-count">' + metric(e) + '</span>' : null; }
  function winRateMetric(e) { return pct(e.w / e.t) + dim('(' + e.w + '-' + e.l + ')'); }

  var ROWS = [
    { label: 'Record', cell: singles(function (p) { return p.w + '-' + p.l; }), num: singles(function (p) { return p.g ? p.w / p.g : null; }), dir: 1 },
    { label: 'Win %', cell: singles(function (p) { return p.g ? (p.w / p.g * 100).toFixed(1) + '%' : null; }), num: singles(function (p) { return p.g ? p.w / p.g : null; }), dir: 1 },
    { label: 'Games Played', cell: singles(function (p) { return p.g; }), num: singles(function (p) { return p.g; }), dir: 1 },
    { label: 'Goals Scored', cell: singles(function (p) { return p.gf; }), num: singles(function (p) { return p.gf; }), dir: 1 },
    { label: 'Goals Allowed', cell: singles(function (p) { return p.ga; }), num: singles(function (p) { return p.ga; }), dir: -1 },
    { label: 'Goal Diff.', cell: singles(function (p) { return signed(p.gf - p.ga); }), num: singles(function (p) { return p.gf - p.ga; }), dir: 1 },
    { label: 'Power Ranking', cell: singles(function (p) { return p.pr ? '#' + p.pr : 'Not Qualified' + (p.qn ? '<span class="compare-note">' + esc(p.qn) + '</span>' : ''); }), num: function (p) { return p.pr; }, dir: -1 },
    { label: 'Overall Ranking', cell: singles(function (p) { return p.or ? '#' + p.or : 'Unranked'; }), num: function (p) { return p.or; }, dir: -1 },
    { label: 'Glicko-2 Rating', cell: singles(function (p) { return p.r; }), num: function (p) { return p.r; }, dir: 1 },
    { label: 'RD', cell: singles(function (p) { return p.rd != null ? '&plusmn;' + p.rd : null; }), num: function (p) { return p.rd; }, dir: -1 },
    { label: 'Peak Rating', cell: function (p) { return p.peak ? '<a href="' + tourneyHref(p.peak.t) + '">' + p.peak.v + '</a>' + dim(esc(formatDateHuman(p.peak.d))) : null; }, num: function (p) { return p.peak ? p.peak.v : null; }, dir: 1 },
    { label: 'Longest Win Streak', cell: singles(function (p) { return p.lws; }), num: singles(function (p) { return p.lws; }), dir: 1 },
    { label: 'Longest Loss Streak', cell: singles(function (p) { return p.lls; }), num: singles(function (p) { return p.lls; }), dir: -1 },
    { label: 'Podium Rate (Top 3)', cell: function (p) { return rateCell(p.pod, p.tp); }, num: function (p) { return p.tp ? p.pod / p.tp : null; }, dir: 1 },
    { label: 'Top 8 Rate', cell: function (p) { return rateCell(p.t8, p.tp); }, num: function (p) { return p.tp ? p.t8 / p.tp : null; }, dir: 1 },
    { label: 'Giant Killer Wins', cell: singles(function (p) { return tierCell(p.gk, p.gkM, true); }), num: singles(function (p) { return p.gk; }), dir: 1 },
    { label: 'Upset Victim Losses', cell: singles(function (p) { return tierCell(p.uv, p.uvM, false); }), num: singles(function (p) { return p.uv; }), dir: -1 },
    { label: 'Tournaments', cell: function (p) { return p.tc; }, num: function (p) { return p.tc; }, dir: 1 },
    { label: 'Last Active', cell: function (p) { return p.la ? esc(formatDateHuman(p.la)) : null; }, num: function (p) { return p.la ? Number(p.la.replace(/-/g, '')) : null; }, dir: 1 },
    { label: 'Best Win', cell: function (p) {
      if (!p.bw) return null;
      var rank = p.bw.rk != null ? '#' + p.bw.rk : 'Unranked';
      var spots = p.bw.sp != null ? dim('(' + signed(p.bw.sp) + ')') : '';
      return playerLink(p.bw.s, p.bw.n) + ' <span class="h2h-count">' + rank + '</span>' + spots;
    }, dir: 0 },
    { label: 'Rival (Min. 3)', cell: function (p) { return oppCell(p.rv, winRateMetric); }, dir: 0 },
    { label: 'Most Played', cell: function (p) { return oppCell(p.mp, function (e) { return '&times;' + e.t; }); }, dir: 0 },
    { label: 'Best Win Rate (Min. 3)', cell: function (p) { return oppCell(p.bwr, winRateMetric); }, dir: 0 },
    { label: 'Worst Win Rate (Min. 3)', cell: function (p) { return oppCell(p.wwr, winRateMetric); }, dir: 0 },
    { label: 'Most Wins Against', cell: function (p) { return oppCell(p.mwa, function (e) { return '&times;' + e.w; }); }, dir: 0 },
    { label: 'Most Losses Against', cell: function (p) { return oppCell(p.mla, function (e) { return '&times;' + e.l; }); }, dir: 0 },
  ];

  function playerHeaderCell(slug, i) {
    var p = PLAYERS[slug];
    return '<th class="compare-player-col" style="--col-color:' + COLORS[i] + '">' +
      '<span class="compare-col-bar"></span>' +
      '<span class="compare-col-name">' + flagImg(p.f) + '<a href="' + playerHref(slug) + '">' + esc(p.n) + '</a></span>' +
      (p.loc ? '<span class="compare-col-sub">' + esc(p.loc) + '</span>' : '') +
      '</th>';
  }

  function renderStatsTable() {
    var players = selected.map(function (s) { return PLAYERS[s]; });
    var head = '<tr><th class="compare-stat-col"></th>' + selected.map(playerHeaderCell).join('') + '</tr>';
    var body = ROWS.map(function (row) {
      var nums = row.num ? players.map(row.num) : players.map(function () { return null; });
      var present = nums.filter(function (n) { return n != null; });
      var best = null;
      if (row.dir && present.length >= 2) {
        var candidate = row.dir > 0 ? Math.max.apply(null, present) : Math.min.apply(null, present);
        var allEqual = present.every(function (n) { return n === candidate; });
        if (!allEqual) best = candidate;
      }
      var cells = players.map(function (p, i) {
        var html = row.cell(p);
        if (html == null || html === '') return '<td class="compare-empty">&mdash;</td>';
        var isBest = best != null && nums[i] === best;
        return '<td' + (isBest ? ' class="compare-best"' : '') + '>' + html + '</td>';
      }).join('');
      return '<tr><td class="compare-stat-label">' + esc(row.label) + '</td>' + cells + '</tr>';
    }).join('');
    return '<div class="table-wrap"><table class="compare-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  // --- Page ------------------------------------------------------------
  function renderHint() {
    var text = '';
    if (selected.length === 0) text = 'Search for a player above to start a comparison. Up to four players can be compared at once.';
    else if (selected.length === 1) text = 'Add another player to compare against ' + esc(PLAYERS[selected[0]].n) + '.';
    hint.innerHTML = text;
    hint.hidden = !text;
  }

  function renderSections() {
    if (!selected.length) { sections.innerHTML = ''; sections.hidden = true; return; }
    sections.hidden = false;
    sections.innerHTML =
      '<div class="tourney-section compare-section"><h2>Stats</h2>' + renderStatsTable() + '</div>';
  }

  function updateTitle() {
    var base = 'Compare Players — DeathBall Power Rankings';
    document.title = selected.length ? selected.map(function (s) { return PLAYERS[s].n; }).join(' vs ') + ' — DeathBall Power Rankings' : base;
  }

  function update(focusSearch) {
    writeSelectionToUrl();
    renderPicker(focusSearch);
    renderHint();
    renderSections();
    updateTitle();
  }

  selected = readSelectionFromUrl();
  update(false);
  // Back/forward between replaceState'd URLs doesn't fire popstate for the
  // same document, but a bfcache restore does re-run nothing -- re-read on
  // pageshow so a restored page matches its URL.
  window.addEventListener('pageshow', function (e) { if (e.persisted) { selected = readSelectionFromUrl(); update(false); } });
})();
`;

function writeComparePage({ data, metaTags, footerHtml, outPath }) {
  // "<" escaped so a player name containing "</script>" can't end the JSON
  // block early.
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compare Players — DeathBall Power Rankings</title>
${metaTags}
<link rel="stylesheet" href="index.css">
</head>
<body class="compare-page">
<div class="player-title-row"><h1>Compare Players</h1></div>
<p class="compare-intro">Pick up to four players to see their stats side by side.</p>
<a class="back-link" href="index.html">&larr; Back to rankings</a>

<div class="compare-picker" id="compare-picker"></div>
<p class="compare-hint" id="compare-hint" hidden></p>
<div id="compare-sections" hidden></div>

<script type="application/json" id="compare-data">${dataJson}</script>
<script>
${CLIENT_JS}
</script>
${footerHtml}
</body>
</html>
`;
  fs.writeFileSync(outPath, stripCommentsInHeadBlocks(html));
}

module.exports = { writeComparePage };
