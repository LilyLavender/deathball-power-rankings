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
  // Column colors: each player gets their own card accent (green/purple,
  // the color their player page uses) when it's still free, first come
  // first served; anyone whose preferred color is already taken is then
  // given the remaining palette colors in order. Recomputed by
  // assignColors() into colors[] (indexed like selected[]) on every update.
  var PALETTE = { green: '#3eff8b', purple: '#b04fff', gold: '#ffd84d', blue: '#4da6ff' };
  var PALETTE_ORDER = ['green', 'purple', 'gold', 'blue'];
  var colors = [];
  function assignColors() {
    var taken = {};
    var names = selected.map(function (slug) {
      var pref = PLAYERS[slug].c;
      if (pref && PALETTE[pref] && !taken[pref]) { taken[pref] = true; return pref; }
      return null;
    });
    names = names.map(function (name) {
      if (name) return name;
      var next = PALETTE_ORDER.filter(function (c) { return !taken[c]; })[0];
      taken[next] = true;
      return next;
    });
    colors = names.map(function (name) { return PALETTE[name]; });
  }
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
  // Fixed-precision variant for the fractional advanced metrics; a value that
  // rounds to zero loses its sign so it never prints as "-0.0".
  function signedFixed(n, digits) {
    var s = n.toFixed(digits);
    if (Number(s) === 0) s = Math.abs(Number(s)).toFixed(digits);
    return (Number(s) > 0 ? '+' : '') + s;
  }

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
      html += '<span class="compare-chip" style="--chip-color:' + colors[i] + '">' +
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

  // Rows grouped under named section headers (rendered as full-width
  // header rows inside the one table so the player columns stay aligned
  // across groups). Groups/labels follow the player page's own sections.
  var GROUPS = [
    { title: 'Record', rows: [
      { label: 'Record', cell: singles(function (p) { return p.w + '-' + p.l; }), num: singles(function (p) { return p.g ? p.w / p.g : null; }), dir: 1 },
      { label: 'Win %', cell: singles(function (p) { return p.g ? (p.w / p.g * 100).toFixed(1) + '%' : null; }), num: singles(function (p) { return p.g ? p.w / p.g : null; }), dir: 1 },
      { label: 'Games Played', cell: singles(function (p) { return p.g; }), num: singles(function (p) { return p.g; }), dir: 1 },
      { label: 'Wins Above .500', cell: singles(function (p) { return signed(p.a5); }), num: singles(function (p) { return p.a5; }), dir: 1 },
      { label: 'Goals Scored', cell: singles(function (p) { return p.gf; }), num: singles(function (p) { return p.gf; }), dir: 1 },
      { label: 'Goals Allowed', cell: singles(function (p) { return p.ga; }), num: singles(function (p) { return p.ga; }), dir: -1 },
      { label: 'Goal Diff.', cell: singles(function (p) { return signed(p.gf - p.ga); }), num: singles(function (p) { return p.gf - p.ga; }), dir: 1 },
      { label: 'Game Diff / Match', cell: singles(function (p) { return p.gdm == null ? null : signedFixed(p.gdm, 2); }), num: singles(function (p) { return p.gdm; }), dir: 1 },
    ] },
    { title: 'Ranking', rows: [
      { label: 'Power Ranking', cell: singles(function (p) { return p.pr ? '#' + p.pr : 'Not Qualified' + (p.qn ? '<span class="compare-note">' + esc(p.qn) + '</span>' : ''); }), num: function (p) { return p.pr; }, dir: -1 },
      { label: 'Overall Ranking', cell: singles(function (p) { return p.or ? '#' + p.or : 'Unranked'; }), num: function (p) { return p.or; }, dir: -1 },
      { label: 'Glicko-2 Rating', cell: singles(function (p) { return p.r; }), num: function (p) { return p.r; }, dir: 1 },
      { label: 'RD', cell: singles(function (p) { return p.rd != null ? '&plusmn;' + p.rd : null; }), num: function (p) { return p.rd; }, dir: -1 },
      { label: 'Peak Rating', cell: function (p) { return p.peak ? '<a href="' + tourneyHref(p.peak.t) + '">' + p.peak.v + '</a>' + dim(esc(formatDateHuman(p.peak.d))) : null; }, num: function (p) { return p.peak ? p.peak.v : null; }, dir: 1 },
      { label: 'Strength of Schedule', cell: singles(function (p) { return p.sos; }), num: singles(function (p) { return p.sos; }), dir: 1 },
      { label: 'Wins Above Expected', cell: singles(function (p) { return p.wae == null ? null : signedFixed(p.wae, 1); }), num: singles(function (p) { return p.wae; }), dir: 1 },
    ] },
    { title: 'Match Statistics', rows: [
      { label: 'Giant Killer Wins', cell: singles(function (p) { return tierCell(p.gk, p.gkM, true); }), num: singles(function (p) { return p.gk; }), dir: 1 },
      { label: 'Upset Victim Losses', cell: singles(function (p) { return tierCell(p.uv, p.uvM, false); }), num: singles(function (p) { return p.uv; }), dir: -1 },
      // Best Win leads with the beaten opponent's current overall rank as
      // the emphasized number (lower rank = better win), then their name
      // and how many spots above/below this player they sit.
      { label: 'Best Win', cell: function (p) {
        if (!p.bw) return null;
        var rank = p.bw.rk != null ? '#' + p.bw.rk : 'Unranked';
        var spots = p.bw.sp != null ? dim('(' + signed(p.bw.sp) + ')') : '';
        return '<span class="h2h-count">' + rank + '</span> <span class="compare-cell-sub">' + playerLink(p.bw.s, p.bw.n) + '</span>' + spots;
      }, num: function (p) { return p.bw && p.bw.rk != null ? p.bw.rk : null; }, dir: -1 },
      { label: 'Tournaments', cell: function (p) { return p.tc; }, num: function (p) { return p.tc; }, dir: 1 },
      { label: 'Podium Rate (Top 3)', cell: function (p) { return rateCell(p.pod, p.tp); }, num: function (p) { return p.tp ? p.pod / p.tp : null; }, dir: 1 },
      { label: 'Top 8 Rate', cell: function (p) { return rateCell(p.t8, p.tp); }, num: function (p) { return p.tp ? p.t8 / p.tp : null; }, dir: 1 },
      { label: 'Longest Win Streak', cell: singles(function (p) { return p.lws; }), num: singles(function (p) { return p.lws; }), dir: 1 },
      { label: 'Longest Loss Streak', cell: singles(function (p) { return p.lls; }), num: singles(function (p) { return p.lls; }), dir: -1 },
    ] },
  ];

  function playerHeaderCell(slug, i) {
    var p = PLAYERS[slug];
    return '<th class="compare-player-col" style="--col-color:' + colors[i] + '">' +
      '<span class="compare-col-bar"></span>' +
      '<span class="compare-col-name">' + flagImg(p.f) + '<a href="' + playerHref(slug) + '">' + esc(p.n) + '</a></span>' +
      (p.loc ? '<span class="compare-col-sub">' + esc(p.loc) + '</span>' : '') +
      '</th>';
  }

  function renderStatsTable() {
    var players = selected.map(function (s) { return PLAYERS[s]; });
    var head = '<tr><th class="compare-stat-col"></th>' + selected.map(playerHeaderCell).join('') + '</tr>';
    var renderRow = function (row) {
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
    };
    var body = GROUPS.map(function (group) {
      return '<tr class="compare-group"><th colspan="' + (players.length + 1) + '">' + esc(group.title) + '</th></tr>' + group.rows.map(renderRow).join('');
    }).join('');
    return '<div class="table-wrap"><table class="compare-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  // --- Shared list helpers ---------------------------------------------
  var PAGE_SIZE = 10;
  // rows: array of HTML strings for <tr>/<li>; everything past PAGE_SIZE
  // starts hidden, revealed PAGE_SIZE at a time by a Show more button
  // (handled by the delegated click listener on #compare-sections).
  function paginated(rows, listId) {
    var items = rows.map(function (r, i) { return i >= PAGE_SIZE ? r.replace(/^<(tr|li)/, '<$1 hidden') : r; }).join('');
    var btn = rows.length > PAGE_SIZE ? '<button type="button" class="show-more-btn" data-list="' + listId + '">Show more</button>' : '';
    return { items: items, button: btn };
  }
  function tourneyLink(slug) {
    var t = TOURNAMENTS[slug];
    if (!t) return esc(slug);
    return flagImg(t.f) + '<a href="' + tourneyHref(slug) + '">' + esc(t.n) + '</a>';
  }
  function colorName(slug, i) {
    return '<a href="' + playerHref(slug) + '" class="compare-colored" style="--col-color:' + colors[i] + '">' + esc(PLAYERS[slug].n) + '</a>';
  }
  function ordinal(n) {
    if (n == null) return '—';
    var mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return n + 'th';
    switch (n % 10) {
      case 1: return n + 'st';
      case 2: return n + 'nd';
      case 3: return n + 'rd';
      default: return n + 'th';
    }
  }
  function dayIndex(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return 0;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
  }
  function formatMonthYear(iso) {
    var m = /^(\d{4})-(\d{2})/.exec(iso || '');
    if (!m) return iso || '';
    return MONTHS[Number(m[2]) - 1] + ' ' + m[1];
  }

  // --- Rating history chart --------------------------------------------
  // Same shell as the player page's chart (.rating-chart-wrap and friends in
  // index.css) but with a real date-scaled x axis across the union of the
  // selected players' histories -- the player page's evenly-spaced
  // one-point-per-tournament axis can't be shared between players who
  // entered different events. One polyline per player in its column color.
  function renderChart() {
    var W = 720, H = 220, padL = 14, padR = 14, padT = 24, padB = 10;
    var series = selected.map(function (slug, i) { return { slug: slug, i: i, p: PLAYERS[slug], rh: PLAYERS[slug].rh || [] }; })
      .filter(function (s) { return s.rh.length >= 1; });
    if (!series.some(function (s) { return s.rh.length >= 2; })) return '';
    var all = [];
    series.forEach(function (s) { s.rh.forEach(function (h) { all.push(h); }); });
    var ratings = all.map(function (h) { return h[1]; });
    var minR = Math.min.apply(null, ratings), maxR = Math.max.apply(null, ratings);
    if (minR === maxR) { minR -= 50; maxR += 50; }
    var span = maxR - minR;
    minR -= span * 0.1; maxR += span * 0.1;
    var days = all.map(function (h) { return dayIndex(h[0]); });
    var minD = Math.min.apply(null, days), maxD = Math.max.apply(null, days);
    var x = function (d) { return padL + (maxD === minD ? 0.5 : (d - minD) / (maxD - minD)) * (W - padL - padR); };
    var y = function (r) { return padT + (1 - (r - minR) / (maxR - minR)) * (H - padT - padB); };

    var gridLines = '', yLabels = '';
    [0, 0.5, 1].forEach(function (t) {
      var gy = padT + t * (H - padT - padB);
      var val = Math.round(maxR - t * (maxR - minR));
      gridLines += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '" class="chart-grid"/>';
      yLabels += '<div class="chart-label chart-label-y" style="top:' + ((gy / H) * 100).toFixed(2) + '%">' + val + '</div>';
    });

    var lines = '', markers = '';
    series.forEach(function (s) {
      var color = colors[s.i];
      var pts = s.rh.map(function (h) { return [x(dayIndex(h[0])), y(h[1])]; });
      if (pts.length >= 2) {
        lines += '<polyline points="' + pts.map(function (pt) { return pt[0].toFixed(1) + ',' + pt[1].toFixed(1); }).join(' ') + '" class="chart-line" style="stroke:' + color + '"/>';
      }
      s.rh.forEach(function (h, k) {
        var t = TOURNAMENTS[h[4]] || { n: h[4] };
        markers += '<a href="' + tourneyHref(h[4]) + '" class="chart-point" tabindex="0"' +
          ' aria-label="' + esc(s.p.n + ': ' + t.n + ', ' + formatDateHuman(h[0]) + ' - Rating ' + h[1] + ', Rank #' + (h[3] || '?')) + '"' +
          ' data-player="' + esc(s.p.n) + '" data-color="' + color + '" data-date="' + esc(formatDateHuman(h[0])) + '" data-label="' + esc(t.n) + '" data-rating="' + h[1] + '" data-rank="' + (h[3] || '') + '">' +
          '<circle cx="' + pts[k][0].toFixed(1) + '" cy="' + pts[k][1].toFixed(1) + '" r="10" class="chart-hit"/>' +
          '<circle cx="' + pts[k][0].toFixed(1) + '" cy="' + pts[k][1].toFixed(1) + '" r="3.5" class="chart-dot" style="fill:' + color + '"/>' +
          '</a>';
      });
    });

    var legend = '<div class="compare-legend">' + series.map(function (s) {
      var last = s.rh[s.rh.length - 1];
      return '<span class="compare-legend-item" style="--col-color:' + colors[s.i] + '"><span class="compare-chip-dot"></span>' + esc(s.p.n) + ' <span class="h2h-record-dim">' + last[1] + '</span></span>';
    }).join('') + '</div>';

    return '<div class="tourney-section compare-section compare-chart-section"><h2>Historical Rating</h2>' + legend +
      '<div class="rating-chart-wrap"><div class="rating-chart-inner">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" class="rating-chart" preserveAspectRatio="none">' + gridLines + lines + markers + '</svg>' +
      yLabels +
      '<div class="chart-label chart-label-date-start">' + esc(formatMonthYear(all.reduce(function (a, h) { return a < h[0] ? a : h[0]; }, all[0][0]))) + '</div>' +
      '<div class="chart-label chart-label-date-end">' + esc(formatMonthYear(all.reduce(function (a, h) { return a > h[0] ? a : h[0]; }, all[0][0]))) + '</div>' +
      '<div class="chart-tooltip" data-show="false"></div>' +
      '</div></div></div>';
  }

  // Hover/focus tooltip, adapted from the player page's chart script: the
  // nearest marker to the pointer (by distance, not just x -- lines cross
  // and overlap here) anywhere over the SVG shows its tooltip, positioned
  // against the chart's inner box.
  function wireChart(wrap) {
    var tooltip = wrap.querySelector('.chart-tooltip');
    var svg = wrap.querySelector('.rating-chart');
    if (!tooltip || !svg) return;
    var points = Array.prototype.slice.call(svg.querySelectorAll('.chart-point'));
    var show = function (point) {
      var wasShown = tooltip.dataset.show === 'true';
      var wrapRect = wrap.getBoundingClientRect();
      var pointRect = point.getBoundingClientRect();
      tooltip.innerHTML = '<strong style="color:' + point.dataset.color + '">' + point.dataset.player + '</strong><br>' +
        point.dataset.label + '<br>' + point.dataset.date + '<br>Rating ' + point.dataset.rating +
        (point.dataset.rank ? ' &middot; Rank #' + point.dataset.rank : '');
      var left = (pointRect.left - wrapRect.left) + (pointRect.width / 2);
      left = Math.max(60, Math.min(left, wrapRect.width - 60));
      var top = pointRect.top - wrapRect.top;
      if (!wasShown) {
        tooltip.style.transition = 'none';
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
        void tooltip.offsetWidth;
        tooltip.style.transition = '';
      } else {
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
      }
      tooltip.dataset.show = 'true';
    };
    var hide = function () { tooltip.dataset.show = 'false'; };
    points.forEach(function (point) {
      point.addEventListener('focus', function () { show(point); });
      point.addEventListener('blur', hide);
    });
    svg.addEventListener('mousemove', function (e) {
      if (!points.length) return;
      var nearest = points[0], nearestDist = Infinity;
      points.forEach(function (p) {
        var r = p.getBoundingClientRect();
        var dx = e.clientX - (r.left + r.width / 2);
        var dy = e.clientY - (r.top + r.height / 2);
        var dist = dx * dx + dy * dy;
        if (dist < nearestDist) { nearestDist = dist; nearest = p; }
      });
      show(nearest);
    });
    svg.addEventListener('mouseleave', hide);
  }

  // --- Head-to-head ----------------------------------------------------
  // Matches among the selected players, taken from the lower-indexed
  // player's match log only so each match appears once.
  function matchesBetweenSelected() {
    var out = [];
    selected.forEach(function (slug, i) {
      (PLAYERS[slug].m || []).forEach(function (m) {
        var j = selected.indexOf(m[0]);
        if (j <= i) return;
        out.push({ a: i, b: j, aWon: !!m[1], date: m[2], order: m[3], scoreA: m[4], scoreB: m[5], t: m[6], dq: !!m[7] });
      });
    });
    out.sort(function (p, q) { return (q.date || '').localeCompare(p.date || '') || (q.order - p.order); });
    return out;
  }

  function h2hWinMatrix(matches) {
    var n = selected.length;
    var wins = [];
    for (var i = 0; i < n; i++) { wins.push([]); for (var j = 0; j < n; j++) wins[i].push(0); }
    matches.forEach(function (m) {
      if (m.aWon) wins[m.a][m.b]++; else wins[m.b][m.a]++;
    });
    return wins;
  }

  // Two-player matchup score, shown above everything else (only with
  // exactly two players; three or more get the matrix inside Head-to-Head).
  function renderH2HScore() {
    if (selected.length !== 2) return '';
    var wins = h2hWinMatrix(matchesBetweenSelected());
    var w0 = wins[0][1], w1 = wins[1][0];
    return '<div class="compare-h2h-record compare-h2h-record-top">' +
      '<span class="compare-h2h-side">' + colorName(selected[0], 0) + '</span>' +
      '<span class="compare-h2h-score"><span class="' + (w0 > w1 ? 'compare-h2h-lead' : '') + '">' + w0 + '</span><span class="compare-h2h-dash">&ndash;</span><span class="' + (w1 > w0 ? 'compare-h2h-lead' : '') + '">' + w1 + '</span></span>' +
      '<span class="compare-h2h-side">' + colorName(selected[1], 1) + '</span>' +
      '</div>';
  }

  function renderHeadToHead() {
    if (selected.length < 2) return '';
    var matches = matchesBetweenSelected();
    var n = selected.length;
    var wins = h2hWinMatrix(matches);

    // Returned in parts (matrix, match log, common opponents, with counts)
    // so renderSections can lay them out differently for two players vs.
    // three or more.
    var summary = '';
    if (n > 2) {
      var head = '<tr><th></th>' + selected.map(function (s, i) { return '<th>' + colorName(s, i) + '</th>'; }).join('') + '</tr>';
      var body = selected.map(function (s, i) {
        return '<tr><th class="row-name">' + colorName(s, i) + '</th>' + selected.map(function (o, j) {
          if (i === j) return '<td class="cell-diag"></td>';
          var w = wins[i][j], l = wins[j][i];
          if (!w && !l) return '<td class="cell-empty">&mdash;</td>';
          var cls = w > l ? 'cell-win' : (l > w ? 'cell-loss' : 'cell-draw');
          return '<td><span class="crosstable-result ' + cls + '">' + w + '-' + l + '</span></td>';
        }).join('') + '</tr>';
      }).join('');
      summary = '<div class="table-wrap"><table class="crosstable compare-matrix"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
    }

    var log;
    if (!matches.length) {
      log = '<p class="compare-empty-note">No matches between these players on record.</p>';
    } else {
      var rows = matches.map(function (m) {
        var winner = m.aWon ? m.a : m.b, loser = m.aWon ? m.b : m.a;
        var scoreW = m.aWon ? m.scoreA : m.scoreB, scoreL = m.aWon ? m.scoreB : m.scoreA;
        return '<li><span class="standings-rank"><span class="match-score-mini">' + (m.dq ? 'DQ' : scoreW + '-' + scoreL) + '</span></span>' +
          '<span>' + colorName(selected[winner], winner) + ' <span class="h2h-record-dim">def.</span> ' + colorName(selected[loser], loser) +
          ' <span class="match-tourney-name">(<a href="' + tourneyHref(m.t) + '">' + esc((TOURNAMENTS[m.t] || { n: m.t }).n) + '</a>)</span></span>' +
          '<span class="standings-record">' + esc(formatDateHuman(m.date)) + '</span></li>';
      });
      var pg = paginated(rows, 'compare-h2h-list');
      log = '<ol class="standings-list" id="compare-h2h-list">' + pg.items + '</ol>' + pg.button;
    }

    // Common opponents: everyone every selected player has faced (excluding
    // the selected players themselves), with each player's record vs them.
    var perPlayer = selected.map(function (slug) {
      var rec = {};
      (PLAYERS[slug].m || []).forEach(function (m) {
        if (!m[0] || selected.indexOf(m[0]) >= 0) return;
        if (!rec[m[0]]) rec[m[0]] = { w: 0, l: 0 };
        if (m[1]) rec[m[0]].w++; else rec[m[0]].l++;
      });
      return rec;
    });
    var common = Object.keys(perPlayer[0]).filter(function (opp) {
      return perPlayer.every(function (rec) { return rec[opp]; });
    }).map(function (opp) {
      var total = perPlayer.reduce(function (sum, rec) { return sum + rec[opp].w + rec[opp].l; }, 0);
      return { slug: opp, total: total };
    }).sort(function (a, b) { return b.total - a.total || PLAYERS[a.slug].n.localeCompare(PLAYERS[b.slug].n); });

    var commonHtml;
    if (!common.length) {
      commonHtml = '<p class="compare-empty-note">No common opponents on record.</p>';
    } else {
      var crows = common.map(function (c) {
        var p = PLAYERS[c.slug];
        return '<tr><td class="compare-stat-label compare-opp-name">' + flagImg(p.f) + '<a href="' + playerHref(c.slug) + '">' + esc(p.n) + '</a></td>' +
          perPlayer.map(function (rec) {
            var r = rec[c.slug];
            var cls = r.w > r.l ? 'result-win' : (r.l > r.w ? 'result-loss' : '');
            return '<td class="' + cls + '">' + r.w + '-' + r.l + '</td>';
          }).join('') + '</tr>';
      });
      var cpg = paginated(crows, 'compare-common-list');
      // Same full player headers (flag, name, location) as the Stats table.
      commonHtml = '<div class="table-wrap"><table class="compare-table compare-common"><thead><tr><th class="compare-stat-col"></th>' +
        selected.map(playerHeaderCell).join('') +
        '</tr></thead><tbody id="compare-common-list">' + cpg.items + '</tbody></table></div>' + cpg.button;
    }

    return {
      matrix: summary,
      matches: log,
      matchCount: matches.length,
      common: commonHtml,
      commonCount: common.length,
    };
  }

  // --- Shared tournaments ----------------------------------------------
  function renderSharedTournaments() {
    if (selected.length < 2) return '';
    var byTourney = {};
    selected.forEach(function (slug, i) {
      (PLAYERS[slug].pl || []).forEach(function (pl) {
        if (!byTourney[pl[0]]) byTourney[pl[0]] = {};
        byTourney[pl[0]][i] = pl;
      });
    });
    var shared = Object.keys(byTourney).filter(function (t) { return Object.keys(byTourney[t]).length >= 2; })
      .sort(function (a, b) { return ((TOURNAMENTS[b] || {}).d || '').localeCompare((TOURNAMENTS[a] || {}).d || ''); });
    var body;
    if (!shared.length) {
      body = '<p class="compare-empty-note">These players have never entered the same tournament.</p>';
    } else {
      var rows = shared.map(function (tSlug) {
        var t = TOURNAMENTS[tSlug] || { n: tSlug, d: '' };
        var pill = t.db ? ' <span class="doubles-pill">Doubles</span>' : '';
        // Best placement (lowest rank) among the selected players who
        // entered this tournament is highlighted; ties highlight each,
        // and a row where everyone tied highlights no one.
        var ranks = selected.map(function (s, i) { return byTourney[tSlug][i] ? byTourney[tSlug][i][1] : null; }).filter(function (r) { return r != null; });
        var bestRank = null;
        if (ranks.length >= 2) {
          var minRank = Math.min.apply(null, ranks);
          if (!ranks.every(function (r) { return r === minRank; })) bestRank = minRank;
        }
        return '<tr><td class="compare-stat-label compare-opp-name">' + tourneyLink(tSlug) + pill + '<span class="compare-col-sub">' + esc(formatDateHuman(t.d)) + '</span></td>' +
          selected.map(function (s, i) {
            var pl = byTourney[tSlug][i];
            if (!pl) return '<td class="compare-empty">&mdash;</td>';
            var partner = pl[5] ? '<span class="compare-col-sub">w/ ' + playerLink(pl[6], pl[7]) + '</span>' : '';
            var isBest = bestRank != null && pl[1] === bestRank;
            return '<td' + (isBest ? ' class="compare-best"' : '') + '><span class="rank-ordinal">' + ordinal(pl[1]) + '<span class="rank-total">/' + pl[2] + '</span></span> <span class="hist-record">' + pl[3] + '-' + pl[4] + '</span>' + partner + '</td>';
          }).join('') + '</tr>';
      });
      var pg = paginated(rows, 'compare-shared-list');
      body = '<div class="table-wrap"><table class="compare-table compare-shared"><thead><tr><th class="compare-stat-col"></th>' +
        selected.map(function (s, i) { return '<th class="compare-player-col compare-player-col-compact" style="--col-color:' + colors[i] + '"><span class="compare-col-bar"></span>' + esc(PLAYERS[s].n) + '</th>'; }).join('') +
        '</tr></thead><tbody id="compare-shared-list">' + pg.items + '</tbody></table></div>' + pg.button;
    }
    return '<div class="tourney-section compare-section"><h2>Shared Tournaments (' + shared.length + ')</h2>' + body + '</div>';
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
    var chart = renderChart();
    var h2h = renderHeadToHead();
    var shared = renderSharedTournaments();
    var section = function (title, body) { return '<div class="tourney-section compare-section"><h2>' + title + '</h2>' + body + '</div>'; };
    var row = function (a, b) { return '<div class="compare-row">' + a + b + '</div>'; };
    var html = renderH2HScore() +
      '<div class="tourney-section compare-section compare-stats-section"><h2>Stats</h2>' + renderStatsTable() + '</div>';
    if (selected.length === 1) {
      if (chart) html += '<div class="compare-row compare-row-centered">' + chart + '</div>';
    } else if (selected.length === 2) {
      // Two players: the score card is already at the top, so Head-to-Head
      // here is the match log. Chart | matches, then common opponents |
      // shared tournaments.
      html += row(chart, section('Head-to-Head Matches (' + h2h.matchCount + ')', h2h.matches)) +
        row(section('Common Opponents (' + h2h.commonCount + ')', h2h.common), shared);
    } else {
      // Three or more: chart | matrix with common opponents under it, then
      // shared tournaments | match log.
      html += row(chart, section('Head-to-Head', h2h.matrix + '<h3 class="compare-subhead">Common Opponents (' + h2h.commonCount + ')</h3>' + h2h.common)) +
        row(shared, section('Matches (' + h2h.matchCount + ')', h2h.matches));
    }
    sections.innerHTML = html;
    sections.querySelectorAll('.rating-chart-inner').forEach(wireChart);
  }

  // Show more buttons (match log, common opponents, shared tournaments):
  // reveal the next PAGE_SIZE hidden rows of the list the button names.
  sections.addEventListener('click', function (e) {
    var btn = e.target.closest('.show-more-btn');
    if (!btn) return;
    var list = document.getElementById(btn.dataset.list);
    if (!list) return;
    var hiddenRows = Array.prototype.filter.call(list.children, function (el) { return el.hidden; });
    hiddenRows.slice(0, PAGE_SIZE).forEach(function (el) { el.hidden = false; });
    if (hiddenRows.length <= PAGE_SIZE) btn.hidden = true;
  });

  function updateTitle() {
    var base = 'Compare Players — DeathBall Power Rankings';
    document.title = selected.length ? selected.map(function (s) { return PLAYERS[s].n; }).join(' vs ') + ' — DeathBall Power Rankings' : base;
  }

  function update(focusSearch) {
    writeSelectionToUrl();
    assignColors();
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
