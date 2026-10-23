(function () {
  const STATE_NAMES = {"AL":"Alabama","AK":"Alaska","AZ":"Arizona","AR":"Arkansas","CA":"California","CO":"Colorado","CT":"Connecticut","DE":"Delaware","FL":"Florida","GA":"Georgia","HI":"Hawaii","ID":"Idaho","IL":"Illinois","IN":"Indiana","IA":"Iowa","KS":"Kansas","KY":"Kentucky","LA":"Louisiana","ME":"Maine","MD":"Maryland","MA":"Massachusetts","MI":"Michigan","MN":"Minnesota","MS":"Mississippi","MO":"Missouri","MT":"Montana","NE":"Nebraska","NV":"Nevada","NH":"New Hampshire","NJ":"New Jersey","NM":"New Mexico","NY":"New York","NC":"North Carolina","ND":"North Dakota","OH":"Ohio","OK":"Oklahoma","OR":"Oregon","PA":"Pennsylvania","RI":"Rhode Island","SC":"South Carolina","SD":"South Dakota","TN":"Tennessee","TX":"Texas","UT":"Utah","VT":"Vermont","VA":"Virginia","WA":"Washington","WV":"West Virginia","WI":"Wisconsin","WY":"Wyoming","DC":"Washington D.C.","AB":"Alberta","BC":"British Columbia","MB":"Manitoba","NB":"New Brunswick","NL":"Newfoundland and Labrador","NS":"Nova Scotia","NT":"Northwest Territories","NU":"Nunavut","ON":"Ontario","PE":"Prince Edward Island","QC":"Quebec","SK":"Saskatchewan","YT":"Yukon"};
  const MAP_REGION_DATA = JSON.parse(document.getElementById('map-region-data')?.textContent || '{}');
  const PR_HISTORY_DATA = JSON.parse(document.getElementById('pr-history-data')?.textContent || '{}');
  const PR_META = PR_HISTORY_DATA.players || {};
  const PR_HISTORY = PR_HISTORY_DATA.checkpoints || [];
  const LOCATION_FILTER = JSON.parse(document.getElementById('location-filter-data')?.textContent || '{"regions":{},"countries":{}}');
  const PR_UNCERTAIN_RD_THRESHOLD = 150;
  function enableSorting(table) {
    const tbody = table.tBodies[0];
    const headers = [...table.querySelectorAll('th')];
    headers.forEach((th, colIndex) => {
      if (th.classList.contains('no-sort')) return;
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
          const valA = (cellA.dataset.sort !== undefined ? cellA.dataset.sort : cellA.textContent).trim().toLowerCase();
          const valB = (cellB.dataset.sort !== undefined ? cellB.dataset.sort : cellB.textContent).trim().toLowerCase();
          if (th.dataset.blankLast === 'true') {
            const blankA = valA === '';
            const blankB = valB === '';
            if (blankA !== blankB) return blankA ? 1 : -1;
          }
          return asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
        });
        rows.forEach((r) => tbody.appendChild(r));
      });
    });
  }
  function moveIndicator(indicator, container, target) {
    if (!indicator || !container || !target) return;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    indicator.style.left = (targetRect.left - containerRect.left) + 'px';
    indicator.style.width = targetRect.width + 'px';
  }
  const TAB_HEADERS = { 'players-tab': 'DeathBall Players', 'tournaments-tab': 'DeathBall Tournaments', 'doubles-tab': 'DeathBall Doubles', 'rankings-tab': 'DeathBall Power Rankings', 'map-tab': 'DeathBall Map', 'events-tab': 'Upcoming DeathBall Events' };
  const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const SCRAMBLE_WINDOW = 8;
  const SCRAMBLE_STEP_MS = 30;
  function scrambleHeading(el, target) {
    if (el._scrambleTimer) clearInterval(el._scrambleTimer);
    const from = el.textContent;
    const len = Math.max(from.length, target.length);
    const fromPadded = from.padEnd(len, ' ');
    const targetPadded = target.padEnd(len, ' ');
    let firstDiff = 0;
    while (firstDiff < len && fromPadded[firstDiff] === targetPadded[firstDiff]) firstDiff++;
    if (firstDiff === len) {
      el.textContent = target;
      return;
    }
    let lastDiff = len - 1;
    while (lastDiff > firstDiff && fromPadded[lastDiff] === targetPadded[lastDiff]) lastDiff--;
    const maxPos = lastDiff + SCRAMBLE_WINDOW;
    let pos = firstDiff;
    function drawFrame() {
      let out = '';
      for (let i = 0; i < len; i++) {
        if (i < pos - SCRAMBLE_WINDOW) {
          out += targetPadded[i];
        } else if (i <= pos) {
          out += fromPadded[i] === targetPadded[i]
            ? targetPadded[i]
            : SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
        } else {
          out += fromPadded[i];
        }
      }
      el.textContent = out.replace(/\s+$/, '');
    }
    drawFrame();
    el._scrambleTimer = setInterval(() => {
      pos++;
      if (pos > maxPos) {
        clearInterval(el._scrambleTimer);
        el._scrambleTimer = null;
        el.textContent = target;
        return;
      }
      drawFrame();
    }, SCRAMBLE_STEP_MS);
  }
  function setHeaderForTab(tabId) {
    const heading = document.getElementById('tab-heading');
    const label = TAB_HEADERS[tabId] || TAB_HEADERS['rankings-tab'];
    if (!heading || heading.textContent === label) return;
    scrambleHeading(heading, label);
  }
  function updateUrlForTab(tabId) {
    const url = new URL(location.href);
    url.searchParams.set('tab', tabId.replace(/-tab$/, ''));
    history.replaceState(null, '', url);
  }
  function enableTabs() {
    const buttons = [...document.querySelectorAll('.tab-button')];
    const panels = [...document.querySelectorAll('.tab-panel')];
    const tabsEl = document.querySelector('.tabs');
    const underline = document.querySelector('.tab-underline');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        panels.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = document.getElementById(btn.dataset.tab);
        panel.classList.add('active');
        moveIndicator(underline, tabsEl, btn);
        setHeaderForTab(btn.dataset.tab);
        updateUrlForTab(btn.dataset.tab);
        updateDownloadVisibility();
        requestAnimationFrame(() => {
          fitCardNames(panel);
          for (const innerToggle of panel.querySelectorAll('.view-toggle')) {
            const innerIndicator = innerToggle.querySelector('.view-toggle-indicator');
            const innerActive = innerToggle.querySelector('.view-btn.active, .delta-btn.active');
            if (innerIndicator && innerActive) moveIndicator(innerIndicator, innerToggle, innerActive);
          }
        });
      });
    });
    moveIndicator(underline, tabsEl, buttons.find((b) => b.classList.contains('active')));
  }
  function activateTabFromQuery() {
    const requested = new URLSearchParams(location.search).get('tab');
    if (!requested) return;
    const btn = document.querySelector('.tab-button[data-tab="' + requested + '-tab"]');
    if (btn && !btn.classList.contains('active')) btn.click();
  }
  function enableTabsMenu() {
    const toggle = document.querySelector('.tabs-toggle');
    const tabsEl = document.querySelector('.tabs');
    const backdrop = document.querySelector('.tabs-backdrop');
    if (!toggle || !tabsEl) return;
    function setOpen(open) {
      tabsEl.classList.toggle('mobile-open', open);
      if (backdrop) backdrop.classList.toggle('mobile-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    }
    toggle.addEventListener('click', () => setOpen(!tabsEl.classList.contains('mobile-open')));
    if (backdrop) backdrop.addEventListener('click', () => setOpen(false));
    tabsEl.querySelectorAll('.tab-button').forEach((btn) => {
      btn.addEventListener('click', () => setOpen(false));
    });
  }
  function enableOptionsToggle() {
    const toggle = document.querySelector('.rankings-options-toggle');
    const panel = document.getElementById('rankings-options-panel');
    if (!toggle || !panel) return;
    toggle.addEventListener('click', () => {
      const open = panel.classList.toggle('options-open');
      toggle.classList.toggle('active', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (open) {
        for (const innerToggle of panel.querySelectorAll('.view-toggle')) {
          const innerIndicator = innerToggle.querySelector('.view-toggle-indicator');
          const innerActive = innerToggle.querySelector('.view-btn.active, .delta-btn.active');
          if (innerIndicator && innerActive) moveIndicator(innerIndicator, innerToggle, innerActive);
        }
      }
    });
  }
  function populateStateFilter(panel) {
    const select = panel.querySelector('.state-filter-select');
    const tbody = panel.querySelector('table tbody');
    if (!select || !tbody) return;
    const countryCounts = new Map();
    const regionCounts = new Map();
    for (const row of tbody.rows) {
      const country = row.dataset.country;
      const region = row.dataset.state;
      if (country) countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
      if (region) regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
    }
    const regionName = (abbr) => (LOCATION_FILTER.regions[abbr] || {}).name || STATE_NAMES[abbr] || abbr;
    const byCountThenName = (nameOf) => (a, b) => (b[1] - a[1]) || nameOf(a[0]).localeCompare(nameOf(b[0]));
    const addGroup = (label, entries, prefix, nameOf, flagOf) => {
      if (!entries.length) return;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const [key] of entries) {
        const opt = document.createElement('option');
        opt.value = prefix + key;
        opt.dataset.label = nameOf(key);
        opt.textContent = opt.dataset.label;
        const flag = flagOf(key);
        if (flag && flag.src) opt.dataset.flag = flag.src;
        group.appendChild(opt);
      }
      select.appendChild(group);
    };
    addGroup('Country', [...countryCounts].sort(byCountThenName((c) => c)), 'c:', (c) => c, (c) => (LOCATION_FILTER.countries[c] || {}).flag);
    addGroup('Region', [...regionCounts].sort(byCountThenName(regionName)), 'r:', regionName, (r) => (LOCATION_FILTER.regions[r] || {}).flag);
    if (select.options[0]) select.options[0].dataset.label = select.options[0].textContent;
  }
  function applyFilters(panel) {
    const minGames = parseInt(panel.querySelector('.min-games-select')?.value || '0', 10);
    const maxRdVal = panel.querySelector('.max-rd-select')?.value || 'Infinity';
    const maxRd = maxRdVal === 'Infinity' ? Infinity : parseFloat(maxRdVal);
    const locationValue = panel.querySelector('.state-filter-select')?.value || '';
    const locationAttr = locationValue.startsWith('c:') ? 'country' : 'state';
    const location = locationValue.slice(2);
    const tbody = panel.querySelector('table tbody');
    const isRankingsTab = panel.id === 'rankings-tab';
    const DEFAULT_MIN_GAMES = 5;
    const DEFAULT_MAX_RD = 150;
    const grid = isRankingsTab ? panel.querySelector('.pr-grid') : null;
    const countSource = grid ? [...grid.querySelectorAll(':scope > .pr-card')] : (tbody ? [...tbody.rows] : []);
    const countryCounts = new Map();
    const regionCounts = new Map();
    let totalPassingNonState = 0;
    for (const el of countSource) {
      const games = parseInt(el.dataset.games || '0', 10);
      const rd = parseFloat(el.dataset.rd || '0');
      if (minGames && games < minGames) continue;
      if (maxRd !== Infinity && rd > maxRd) continue;
      const rowCountry = el.dataset.country || '';
      const rowState = el.dataset.state || '';
      countryCounts.set(rowCountry, (countryCounts.get(rowCountry) || 0) + 1);
      regionCounts.set(rowState, (regionCounts.get(rowState) || 0) + 1);
      totalPassingNonState++;
    }
    const stateSelect = panel.querySelector('.state-filter-select');
    if (stateSelect) {
      for (const opt of stateSelect.options) {
        const label = opt.dataset.label || opt.textContent.replace(/\s*\(\d+\)$/, '');
        const count = opt.value === '' ? totalPassingNonState
          : opt.value.startsWith('c:') ? (countryCounts.get(opt.value.slice(2)) || 0)
          : (regionCounts.get(opt.value.slice(2)) || 0);
        opt.textContent = label + ' (' + count + ')';
      }
    }
    if (tbody) {
      let rank = 1;
      for (const row of tbody.rows) {
        const games = parseInt(row.dataset.games || '0', 10);
        const rd = parseFloat(row.dataset.rd || '0');
        const passesMinMax = (!minGames || games >= minGames) && (maxRd === Infinity || rd <= maxRd);
        const passesState = !location || (row.dataset[locationAttr] || '') === location;
        const show = passesMinMax && passesState;
        row.hidden = !show;
        if (isRankingsTab) {
          const meetsDefaults = games >= DEFAULT_MIN_GAMES && rd <= DEFAULT_MAX_RD;
          row.classList.toggle('filter-dim', show && !meetsDefaults);
        } else {
          row.classList.remove('filter-dim');
        }
        if (show) {
          const rankCell = row.querySelector('.rank-num');
          if (rankCell) rankCell.textContent = rank++;
        }
      }
    }
    let visible = 0;
    if (grid) {
      let rank = 1;
      for (const card of grid.querySelectorAll(':scope > .pr-card')) {
        const games = parseInt(card.dataset.games || '0', 10);
        const rd = parseFloat(card.dataset.rd || '0');
        const passesMinMax = (!minGames || games >= minGames) && (maxRd === Infinity || rd <= maxRd);
        const passesState = !location || (card.dataset[locationAttr] || '') === location;
        const show = passesMinMax && passesState;
        card.hidden = !show;
        const meetsDefaults = games >= DEFAULT_MIN_GAMES && rd <= DEFAULT_MAX_RD;
        card.classList.toggle('filter-dim', show && !meetsDefaults);
        if (show) {
          const rankEl = card.querySelector('.prc-rank .rank-plain');
          if (rankEl) rankEl.textContent = rank;
          rank++;
          visible++;
        }
      }
      fitCardNames(panel);
    } else if (tbody) {
      for (const row of tbody.rows) if (!row.hidden) visible++;
    }
    const countEl = panel.querySelector('.filter-count');
    if (countEl) {
      const noun = isRankingsTab ? 'players ranked' : 'unique players';
      const table = panel.querySelector('table');
      const tableVisible = !grid || !table || table.style.display !== 'none';
      countEl.textContent = visible + ' ' + noun + (tableVisible ? '. Click a column header to sort.' : '.');
    }
  }
  function fitText(el, maxPx, minPx) {
    el.style.fontSize = maxPx + 'px';
    let size = maxPx;
    while (el.scrollWidth > el.offsetWidth && size > minPx) {
      size -= 1;
      el.style.fontSize = size + 'px';
    }
  }
  function fitCardNames(panel) {
    const scope = panel || document;
    for (const el of scope.querySelectorAll('.prc-name')) fitText(el, 18, 9);
  }
  function countColor(count, max) {
    if (!count) return 'rgba(255, 255, 255, 0.05)';
    const t = max > 0 ? Math.sqrt(count / max) : 0;
    const lightness = 16 + t * 44;
    return 'hsl(150, 70%, ' + lightness.toFixed(1) + '%)';
  }
  function updateMap(panel, view) {
    const regions = [...panel.querySelectorAll('.map-region')];
    const labels = [...panel.querySelectorAll('.map-label')];
    let max = 1;
    for (const r of regions) max = Math.max(max, parseInt(r.dataset[view] || '0', 10));
    regions.forEach((r) => {
      const count = parseInt(r.dataset[view] || '0', 10);
      r.style.fill = countColor(count, max);
    });
    labels.forEach((l) => {
      const count = parseInt(l.dataset[view] || '0', 10);
      l.textContent = count > 0 ? count : '';
    });
  }
  function enableMapToggle(panel) {
    if (!panel) return;
    const buttons = [...panel.querySelectorAll('.view-btn')];
    const toggleEl = panel.querySelector('.view-toggle');
    const indicator = panel.querySelector('.view-toggle-indicator');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        moveIndicator(indicator, toggleEl, btn);
        updateMap(panel, btn.dataset.view);
        if (panel._mapRefreshSidebar) panel._mapRefreshSidebar();
      });
    });
    const active = buttons.find((b) => b.classList.contains('active'));
    moveIndicator(indicator, toggleEl, active);
    updateMap(panel, active ? active.dataset.view : 'players');
  }
  const MAP_WORLD_BOUNDS = { minX: -700, minY: -1200, maxX: 3900, maxY: 1950 };
  const MAP_ZOOM_OUT_MAX_WIDTH = MAP_WORLD_BOUNDS.maxX - MAP_WORLD_BOUNDS.minX;
  function clampMapBox(x, y, width, height) {
    const boundsW = MAP_WORLD_BOUNDS.maxX - MAP_WORLD_BOUNDS.minX;
    const boundsH = MAP_WORLD_BOUNDS.maxY - MAP_WORLD_BOUNDS.minY;
    const cx = width >= boundsW
      ? MAP_WORLD_BOUNDS.minX + (boundsW - width) / 2
      : Math.min(Math.max(x, MAP_WORLD_BOUNDS.minX), MAP_WORLD_BOUNDS.maxX - width);
    const cy = height >= boundsH
      ? MAP_WORLD_BOUNDS.minY + (boundsH - height) / 2
      : Math.min(Math.max(y, MAP_WORLD_BOUNDS.minY), MAP_WORLD_BOUNDS.maxY - height);
    return [cx, cy, width, height];
  }
  function animateViewBox(svg, toBox, duration) {
    const clampedTo = clampMapBox(toBox[0], toBox[1], toBox[2], toBox[3]);
    const fromBox = svg.getAttribute('viewBox').split(' ').map(Number);
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const box = fromBox.map((v, i) => v + (clampedTo[i] - v) * eased);
      svg.setAttribute('viewBox', box.join(' '));
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function mapFlagNameSpan(item) {
    const nameSpan = document.createElement('span');
    nameSpan.className = 'hist-tourney-name';
    if (item.f) {
      const img = document.createElement('img');
      img.className = 'loc-flag';
      img.src = item.f.src;
      img.alt = item.f.title;
      img.title = item.f.title;
      nameSpan.appendChild(img);
    }
    if (item.h) {
      const a = document.createElement('a');
      a.href = item.h;
      a.textContent = item.n;
      nameSpan.appendChild(a);
    } else {
      nameSpan.appendChild(document.createTextNode(item.n));
    }
    return nameSpan;
  }
  const MAP_SIDEBAR_COLUMNS = {
    players: [
      { label: 'Player', key: 'n', type: 'string' },
      { label: 'Placement', key: 'rank', type: 'number' },
      { label: 'Rating', key: 'v', type: 'number' },
      { label: 'Last Active', key: 'la', type: 'string' },
    ],
    tournaments: [
      { label: 'Tournament', key: 'n', type: 'string' },
      { label: 'Date', key: 'di', type: 'string' },
    ],
  };
  function sortMapItems(items, sort, columns) {
    if (!sort) return items;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return items;
    const sorted = items.slice();
    sorted.sort((a, b) => {
      if (col.type === 'number') {
        const valA = Number(a[col.key]);
        const valB = Number(b[col.key]);
        return sort.asc ? valA - valB : valB - valA;
      }
      const valA = String(a[col.key] || '').toLowerCase();
      const valB = String(b[col.key] || '').toLowerCase();
      return sort.asc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    });
    return sorted;
  }
  function renderMapSidebar(panel, regionId, view) {
    const data = MAP_REGION_DATA[regionId];
    if (!data) return;
    const list = panel.querySelector('.map-sidebar-list');
    const colhead = panel.querySelector('.map-sidebar-colhead');
    const title = panel.querySelector('.map-sidebar-title');
    const backBtn = panel.querySelector('.map-sidebar-back');
    title.textContent = data.name;
    if (backBtn) backBtn.hidden = regionId === '__ALL__';
    const isTournaments = view === 'tournaments';
    list.classList.toggle('map-cols-players', !isTournaments);
    list.classList.toggle('map-cols-tournaments', isTournaments);
    colhead.classList.toggle('map-cols-players', !isTournaments);
    colhead.classList.toggle('map-cols-tournaments', isTournaments);
    colhead.innerHTML = '';
    if (!panel._mapSort) panel._mapSort = { players: null, tournaments: null };
    const sortKey = isTournaments ? 'tournaments' : 'players';
    const columns = MAP_SIDEBAR_COLUMNS[sortKey];
    const currentSort = panel._mapSort[sortKey];
    columns.forEach((col) => {
      const span = document.createElement('span');
      span.textContent = col.label;
      if (currentSort && currentSort.key === col.key) {
        span.classList.add(currentSort.asc ? 'sorted-asc' : 'sorted-desc');
      }
      span.addEventListener('click', () => {
        const prev = panel._mapSort[sortKey];
        if (!prev || prev.key !== col.key) {
          panel._mapSort[sortKey] = { key: col.key, asc: true };
        } else if (prev.asc) {
          panel._mapSort[sortKey] = { key: col.key, asc: false };
        } else {
          panel._mapSort[sortKey] = null;
        }
        if (panel._mapRefreshSidebar) panel._mapRefreshSidebar();
        else renderMapSidebar(panel, regionId, view);
      });
      colhead.appendChild(span);
    });
    list.innerHTML = '';
    const items = sortMapItems(isTournaments ? data.tournamentsList : data.playersList, currentSort, columns);
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'map-sidebar-empty';
      li.textContent = 'No ' + view + ' from here yet.';
      list.appendChild(li);
      return;
    }
    items.forEach((item) => {
      const li = document.createElement('li');
      li.appendChild(mapFlagNameSpan(item));
      if (isTournaments) {
        const dateSpan = document.createElement('span');
        dateSpan.className = 'standings-record';
        dateSpan.textContent = item.d || '';
        li.appendChild(dateSpan);
      } else {
        const rankSpan = document.createElement('span');
        rankSpan.className = 'standings-record';
        rankSpan.textContent = item.rank != null ? '#' + item.rank : '—';
        li.appendChild(rankSpan);
        const ratingSpan = document.createElement('span');
        ratingSpan.className = 'standings-record';
        ratingSpan.textContent = item.v != null ? item.v + ' ± ' + item.rd : 'Unranked';
        li.appendChild(ratingSpan);
        const lastActiveSpan = document.createElement('span');
        lastActiveSpan.className = 'standings-record';
        lastActiveSpan.textContent = item.la || '';
        li.appendChild(lastActiveSpan);
      }
      list.appendChild(li);
    });
  }
  function zoomToRegion(svg, regionEl) {
    const bbox = regionEl.getBBox();
    const padFactor = 0.4;
    const minSize = 40;
    const w = Math.max(bbox.width * (1 + padFactor * 2), minSize);
    const h = Math.max(bbox.height * (1 + padFactor * 2), minSize);
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    animateViewBox(svg, [cx - w / 2, cy - h / 2, w, h], 450);
  }
  function zoomMapHome(svg) {
    const home = (svg.dataset.home || '').split(' ').map(Number);
    if (home.length === 4 && home.every((n) => !isNaN(n))) animateViewBox(svg, home, 450);
  }
  function enableMapPinchZoom(svg) {
    const home = (svg.dataset.home || '').split(' ').map(Number);
    if (home.length !== 4 || home.some((n) => isNaN(n))) return;
    const maxW = MAP_ZOOM_OUT_MAX_WIDTH;
    const minW = home[2] * 0.15;
    let startDist = null;
    let startBox = null;
    let anchor = null;
    function touchDist(touches) {
      return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    }
    function toSvgPoint(clientX, clientY) {
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      return pt.matrixTransform(ctm.inverse());
    }
    function endPinch() {
      startDist = null;
      startBox = null;
      anchor = null;
    }
    svg.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      startDist = touchDist(e.touches);
      const vb = svg.viewBox.baseVal;
      startBox = { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
      anchor = toSvgPoint(
        (e.touches[0].clientX + e.touches[1].clientX) / 2,
        (e.touches[0].clientY + e.touches[1].clientY) / 2
      );
    }, { passive: false });
    svg.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2 || !startDist || !startBox || !anchor) return;
      e.preventDefault();
      const scale = startDist / touchDist(e.touches);
      const newW = Math.max(minW, Math.min(maxW, startBox.width * scale));
      const newH = newW * (startBox.height / startBox.width);
      const fx = (anchor.x - startBox.x) / startBox.width;
      const fy = (anchor.y - startBox.y) / startBox.height;
      const [cx, cy, cw, ch] = clampMapBox(anchor.x - fx * newW, anchor.y - fy * newH, newW, newH);
      svg.setAttribute('viewBox', cx.toFixed(2) + ' ' + cy.toFixed(2) + ' ' + cw.toFixed(2) + ' ' + ch.toFixed(2));
    }, { passive: false });
    svg.addEventListener('touchend', (e) => { if (e.touches.length < 2) endPinch(); });
    svg.addEventListener('touchcancel', endPinch);
  }
  function enableMapWheelZoom(svg) {
    const home = (svg.dataset.home || '').split(' ').map(Number);
    if (home.length !== 4 || home.some((n) => isNaN(n))) return;
    const maxW = MAP_ZOOM_OUT_MAX_WIDTH;
    const minW = home[2] * 0.15;
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const anchor = pt.matrixTransform(ctm.inverse());
      const vb = svg.viewBox.baseVal;
      const factor = Math.exp(e.deltaY * 0.0015);
      const newW = Math.max(minW, Math.min(maxW, vb.width * factor));
      const newH = newW * (vb.height / vb.width);
      const fx = (anchor.x - vb.x) / vb.width;
      const fy = (anchor.y - vb.y) / vb.height;
      const [cx, cy, cw, ch] = clampMapBox(anchor.x - fx * newW, anchor.y - fy * newH, newW, newH);
      svg.setAttribute('viewBox', cx + ' ' + cy + ' ' + cw + ' ' + ch);
    }, { passive: false });
  }
  const MAP_DRAG_THRESHOLD = 4;
  function enableMapDrag(panel, svg) {
    let dragging = false;
    let moved = false;
    let startClientX = 0;
    let startClientY = 0;
    let startBox = null;
    function svgUnitsPerPixel() {
      const ctm = svg.getScreenCTM();
      if (!ctm || !ctm.a || !ctm.d) return { x: 1, y: 1 };
      return { x: 1 / ctm.a, y: 1 / ctm.d };
    }
    svg.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      startClientX = e.clientX;
      startClientY = e.clientY;
      const vb = svg.viewBox.baseVal;
      startBox = { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging || !startBox) return;
      const dxClient = e.clientX - startClientX;
      const dyClient = e.clientY - startClientY;
      if (!moved) {
        if (Math.hypot(dxClient, dyClient) < MAP_DRAG_THRESHOLD) return;
        moved = true;
        panel._mapWasDragged = true;
        svg.classList.add('dragging');
      }
      const scale = svgUnitsPerPixel();
      const dx = dxClient * scale.x;
      const dy = dyClient * scale.y;
      const [cx, cy, cw, ch] = clampMapBox(startBox.x - dx, startBox.y - dy, startBox.width, startBox.height);
      svg.setAttribute('viewBox', cx + ' ' + cy + ' ' + cw + ' ' + ch);
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      startBox = null;
      svg.classList.remove('dragging');
      if (moved) setTimeout(() => { panel._mapWasDragged = false; }, 0);
    });
  }
  function enableMapRegions(panel) {
    if (!panel) return;
    const svg = panel.querySelector('.map-svg');
    const regions = [...panel.querySelectorAll('.map-region')];
    const backBtn = panel.querySelector('.map-sidebar-back');
    let selectedId = '__ALL__';
    enableMapPinchZoom(svg);
    enableMapDrag(panel, svg);
    enableMapWheelZoom(svg);
    function currentView() {
      const active = panel.querySelector('.view-btn.active');
      return active ? active.dataset.view : 'players';
    }
    function deselect() {
      regions.forEach((r) => r.classList.remove('selected'));
      selectedId = '__ALL__';
      zoomMapHome(svg);
      renderMapSidebar(panel, selectedId, currentView());
    }
    let pendingDeselect = null;
    regions.forEach((r) => {
      r.addEventListener('click', () => {
        if (panel._mapWasDragged) return;
        if (selectedId === r.dataset.id) {
          if (pendingDeselect) clearTimeout(pendingDeselect);
          pendingDeselect = setTimeout(() => { pendingDeselect = null; deselect(); }, 300);
          return;
        }
        regions.forEach((other) => other.classList.remove('selected'));
        r.classList.add('selected');
        selectedId = r.dataset.id;
        zoomToRegion(svg, r);
        renderMapSidebar(panel, selectedId, currentView());
      });
      r.addEventListener('dblclick', () => {
        if (pendingDeselect) { clearTimeout(pendingDeselect); pendingDeselect = null; }
      });
    });
    if (backBtn) backBtn.addEventListener('click', deselect);
    renderMapSidebar(panel, selectedId, currentView());
    panel._mapRefreshSidebar = () => renderMapSidebar(panel, selectedId, currentView());
  }
  async function inlineImages(root) {
    const imgs = [...root.querySelectorAll('img')];
    await Promise.all(imgs.map(async (img) => {
      try {
        const resp = await fetch(img.src);
        const blob = await resp.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        img.src = dataUrl;
      } catch (_) {
      }
    }));
  }
  async function bakeFlagAspect(root) {
    const imgs = [...root.querySelectorAll('img.prc-flag')];
    await Promise.all(imgs.map(async (img) => {
      if (!img.complete) await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      if (!iw || !ih) return;
      const rect = img.getBoundingClientRect();
      const boxW = Math.max(1, Math.round(rect.width * 2));
      const boxH = Math.max(1, Math.round(rect.height * 2));
      const scale = Math.min(boxW / iw, boxH / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const canvas = document.createElement('canvas');
      canvas.width = boxW;
      canvas.height = boxH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, (boxW - dw) / 2, (boxH - dh) / 2, dw, dh);
      img.src = canvas.toDataURL('image/png');
    }));
  }
  async function downloadRankingsImage(panel) {
    const grid = panel.querySelector('.pr-grid');
    if (!grid || !window.html2canvas) throw new Error('Power Ranking grid or html2canvas unavailable');
    await document.fonts.ready;
    const square = grid.querySelector('.pr-square');
    const qualifying = [...grid.querySelectorAll(':scope > .pr-card')].filter((c) => {
      const games = parseInt(c.dataset.games || '0', 10);
      const rd = parseFloat(c.dataset.rd || '0');
      return games >= 5 && rd <= 150;
    });
    const cards = qualifying.slice(0, 100);
    const clone = document.createElement('div');
    clone.className = 'pr-grid pr-export-grid' + (panel.classList.contains('show-rank-delta') ? ' show-rank-delta' : '');
    clone.style.gridTemplateColumns = 'repeat(8, 1fr)';
    clone.style.boxSizing = 'content-box';
    clone.style.width = '1472px';
    clone.style.padding = '24px';
    clone.style.background = '#050505';
    if (square) {
      const squareClone = square.cloneNode(true);
      squareClone.style.display = 'flex';
      clone.appendChild(squareClone);
    }
    cards.forEach((c, idx) => {
      const cardClone = c.cloneNode(true);
      cardClone.hidden = false;
      cardClone.classList.remove('filter-dim', 'uncertain');
      const rankEl = cardClone.querySelector('.prc-rank .rank-plain');
      if (rankEl) rankEl.textContent = idx + 1;
      clone.appendChild(cardClone);
    });
    document.body.appendChild(clone);
    const glowCache = {};
    const glowBackgrounds = {
      'card-green': 'radial-gradient(ellipse at 20% 0%, rgba(62,255,139,0.22) 0%, #0f0f0f 65%)',
      'card-purple': 'radial-gradient(ellipse at 20% 0%, rgba(176,79,255,0.22) 0%, #0f0f0f 65%)',
    };
    async function glowDataUri(cardClass, w, h) {
      const key = cardClass + '|' + w + '|' + h;
      if (glowCache[key]) return glowCache[key];
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      const fo = document.createElementNS(svgNS, 'foreignObject');
      fo.setAttribute('width', '100%');
      fo.setAttribute('height', '100%');
      const div = document.createElement('div');
      div.style.width = w + 'px';
      div.style.height = h + 'px';
      div.style.margin = '0';
      div.style.background = glowBackgrounds[cardClass];
      fo.appendChild(div);
      svg.appendChild(fo);
      const svgStr = new XMLSerializer().serializeToString(svg);
      const svgUri = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgStr)));
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = svgUri; });
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f0f0f';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0);
      const uri = canvas.toDataURL('image/png');
      glowCache[key] = uri;
      return uri;
    }
    await Promise.all([...clone.querySelectorAll('.pr-card')].map(async (c) => {
      const isGreen = c.classList.contains('card-green');
      const isPurple = c.classList.contains('card-purple');
      if (isGreen || isPurple) {
        const rect = c.getBoundingClientRect();
        const uri = await glowDataUri(isGreen ? 'card-green' : 'card-purple', rect.width, rect.height);
        c.style.background = 'url(' + uri + ')';
        c.style.backgroundSize = '100% 100%';
      } else {
        c.style.background = '#0f0f0f';
      }
    }));
    fitCardNames(clone);
    await inlineImages(clone);
    await bakeFlagAspect(clone);
    try {
      const canvas = await html2canvas(clone, {
        backgroundColor: '#050505',
        scale: 2,
        useCORS: true,
        ignoreElements: (node) => node.tagName === 'IMG' && !node.src.startsWith('data:'),
      });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const now = new Date();
      const dateStamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      a.download = 'deathball-power-rankings-' + dateStamp + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      clone.remove();
    }
  }
  const CSV_PLAYER_DATA = JSON.parse(document.getElementById('csv-player-data')?.textContent || '[]');
  const CSV_TOURNAMENT_DATA = JSON.parse(document.getElementById('csv-tournament-data')?.textContent || '[]');
  const CSV_DATASETS = {
    players: {
      headers: ['Seed', 'Player', 'Rating', 'RD', 'City', 'State', 'Country', 'Wins', 'Losses', 'Games', 'Win %', 'Last Active', 'Tournaments Attended'],
      rows: () => CSV_PLAYER_DATA.map((p) => [
        p.seed ?? '', p.name, p.rating ?? '', p.rd ?? '', p.city, p.state, p.country, p.wins, p.losses, p.games,
        p.winPct != null ? p.winPct.toFixed(1) + '%' : '', p.lastActive, p.tournamentCount,
      ]),
    },
    tournaments: {
      headers: ['Tournament', 'Date', 'Venue', 'City', 'State', 'Country', 'Source', 'Participants', 'Matches', 'Tournament Type', 'Bracket Type', 'Bracket URL', 'VOD URL'],
      rows: () => CSV_TOURNAMENT_DATA.map((t) => [
        t.name, t.date, t.venue, t.city, t.state, t.country, t.source, t.participants, t.matches,
        t.tournamentType, t.bracketType, t.bracketUrl, t.videoUrl,
      ]),
    },
  };
  function csvEscape(value) {
    const s = String(value ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCsvDataset(datasetKey, filenamePrefix) {
    const dataset = CSV_DATASETS[datasetKey];
    if (!dataset) throw new Error('Unknown CSV dataset: ' + datasetKey);
    const csv = [dataset.headers, ...dataset.rows()].map((row) => row.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    const dateStamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    a.href = url;
    a.download = filenamePrefix + '-' + dateStamp + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  function enableCsvDownloadButtons() {
    document.querySelectorAll('.csv-download-btn').forEach((btn) => {
      const label = btn.querySelector('.download-btn-label');
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        try {
          downloadCsvDataset(btn.dataset.csvKey, btn.dataset.csvFilename || 'deathball-export');
        } catch (err) {
          btn.classList.add('failed');
          if (label) label.textContent = 'Failed — Retry';
          return;
        }
        btn.classList.remove('failed');
        if (label) label.textContent = 'Download CSV';
      });
    });
  }
  function updateDownloadVisibility() {
    const btns = document.querySelectorAll('.download-btn');
    if (!btns.length) return;
    const rankingsPanel = document.getElementById('rankings-tab');
    const rankingsActive = !!rankingsPanel && rankingsPanel.classList.contains('active');
    const gridActive = !!rankingsPanel && !!rankingsPanel.querySelector('.view-btn[data-view="grid"].active');
    const hide = !(rankingsActive && gridActive);
    btns.forEach((btn) => { btn.hidden = hide; });
  }
  function updateCsvDownloadVisibility() {
    const rankingsPanel = document.getElementById('rankings-tab');
    if (!rankingsPanel) return;
    const csvBtn = rankingsPanel.querySelector('.csv-download-btn');
    if (!csvBtn) return;
    const tableActive = !!rankingsPanel.querySelector('.view-btn[data-view="table"].active');
    csvBtn.hidden = !tableActive;
  }
  function enableViewToggle(panel) {
    const buttons = [...panel.querySelectorAll('.view-btn')];
    if (!buttons.length) return;
    const grid = panel.querySelector('.pr-grid');
    const table = panel.querySelector('table');
    const toggleEl = panel.querySelector('.view-toggle');
    const indicator = panel.querySelector('.view-toggle-indicator');
    const rankDeltaToggle = panel.querySelector('.rank-delta-toggle');
    document.querySelectorAll('.download-btn').forEach((downloadBtn) => {
      const downloadLabel = downloadBtn.querySelector('.download-btn-label');
      const iconSlot = downloadBtn.querySelector('.download-icon-slot');
      const check = downloadBtn.querySelector('.t-success-check');
      downloadBtn.addEventListener('click', async () => {
        if (downloadBtn.disabled) return;
        downloadBtn.disabled = true;
        downloadBtn.classList.remove('failed');
        downloadBtn.classList.add('loading');
        if (iconSlot) iconSlot.dataset.state = 'loading';
        if (downloadLabel) downloadLabel.textContent = 'Preparing…';
        try {
          await downloadRankingsImage(panel);
          if (downloadLabel) downloadLabel.textContent = 'Download Top 100';
          if (iconSlot) iconSlot.dataset.state = 'success';
          if (check) {
            check.dataset.state = 'out';
            void check.offsetWidth;
            check.dataset.state = 'in';
          }
          setTimeout(() => {
            if (iconSlot) iconSlot.dataset.state = 'idle';
            if (check) check.dataset.state = 'out';
          }, 1400);
        } catch (err) {
          downloadBtn.classList.add('failed');
          if (downloadLabel) downloadLabel.textContent = 'Failed — Retry';
          if (iconSlot) iconSlot.dataset.state = 'idle';
        } finally {
          downloadBtn.disabled = false;
          downloadBtn.classList.remove('loading');
        }
      });
    });
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.dataset.view;
        if (grid) grid.style.display = view === 'grid' ? '' : 'none';
        if (table) table.style.display = view === 'table' ? '' : 'none';
        updateDownloadVisibility();
        updateCsvDownloadVisibility();
        if (rankDeltaToggle) rankDeltaToggle.hidden = view !== 'grid';
        moveIndicator(indicator, toggleEl, btn);
        applyFilters(panel);
      });
    });
    const activeBtn = buttons.find((b) => b.classList.contains('active'));
    updateDownloadVisibility();
    updateCsvDownloadVisibility();
    if (rankDeltaToggle) rankDeltaToggle.hidden = !activeBtn || activeBtn.dataset.view !== 'grid';
    moveIndicator(indicator, toggleEl, activeBtn);
  }
  function enableRankDeltaToggle(panel) {
    const toggleEl = panel.querySelector('.rank-delta-toggle');
    if (!toggleEl) return;
    const buttons = [...toggleEl.querySelectorAll('.delta-btn')];
    const indicator = toggleEl.querySelector('.view-toggle-indicator');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        panel.classList.toggle('show-rank-delta', btn.dataset.delta === 'show');
        moveIndicator(indicator, toggleEl, btn);
      });
    });
    const activeBtn = buttons.find((b) => b.classList.contains('active'));
    moveIndicator(indicator, toggleEl, activeBtn);
  }
  function prCardAccent(id, colorOverride) {
    if (colorOverride === 'green' || colorOverride === 'purple') return 'card-' + colorOverride;
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
    return (h & 1) ? 'card-purple' : 'card-green';
  }
  function prRankDeltaState(row) {
    if (row.isNew) return 'new';
    if (!row.placementChange) return null;
    return row.placementChange > 0 ? 'up' : 'down';
  }
  function prRankDeltaBadge(row) {
    const state = prRankDeltaState(row);
    if (!state) return null;
    const span = document.createElement('span');
    if (state === 'new') {
      span.className = 'rank-delta rank-delta-new';
      span.textContent = 'NEW';
    } else if (state === 'up') {
      span.className = 'rank-delta rank-delta-up';
      span.textContent = '▲' + row.placementChange;
    } else {
      span.className = 'rank-delta rank-delta-down';
      span.textContent = '▼' + Math.abs(row.placementChange);
    }
    return span;
  }
  function prFlagImg(flag, className) {
    if (!flag) return null;
    const img = document.createElement('img');
    img.className = className;
    img.src = flag.src;
    img.title = flag.title;
    img.alt = flag.title;
    return img;
  }
  function buildRankingCard(row, meta, rank) {
    const card = document.createElement('div');
    card.className = 'pr-card ' + prCardAccent(row.id, meta.color) + (row.uncertain ? ' uncertain' : '');
    card.dataset.games = row.games;
    card.dataset.rd = row.rd;
    if (meta.state) card.dataset.state = meta.state;
    if (meta.country) card.dataset.country = meta.country;
    const top = document.createElement('div');
    top.className = 'prc-top';
    const rankSpan = document.createElement('span');
    rankSpan.className = 'prc-rank';
    const rankPlain = document.createElement('span');
    const deltaState = prRankDeltaState(row);
    rankPlain.className = 'rank-plain' + (deltaState ? ' rank-plain-' + deltaState : '');
    rankPlain.textContent = rank;
    rankSpan.appendChild(rankPlain);
    const badge = prRankDeltaBadge(row);
    if (badge) rankSpan.appendChild(badge);
    top.appendChild(rankSpan);
    const nameEl = document.createElement(meta.href ? 'a' : 'span');
    nameEl.className = 'prc-name';
    nameEl.title = meta.name;
    nameEl.textContent = meta.name;
    if (meta.href) nameEl.href = meta.href;
    top.appendChild(nameEl);
    const flagImg = prFlagImg(meta.flag, 'prc-flag');
    if (flagImg) top.appendChild(flagImg);
    card.appendChild(top);
    const stats = document.createElement('div');
    stats.className = 'prc-stats';
    const addVal = (text, cls) => {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      stats.appendChild(span);
    };
    addVal(String(row.r), 'prc-val');
    addVal('±', 'prc-dim');
    addVal(String(row.rd), 'prc-val');
    addVal('|', 'prc-sep');
    addVal(String(Math.round(row.winPct * 100)), 'prc-val');
    addVal('W%', 'prc-dim');
    addVal('|', 'prc-sep');
    addVal(String(row.games), 'prc-val');
    addVal('gp', 'prc-dim');
    if (meta.locAbbr) {
      const abbrSpan = document.createElement('span');
      abbrSpan.className = 'prc-loc-abbr';
      abbrSpan.title = meta.location;
      abbrSpan.textContent = meta.locAbbr;
      stats.appendChild(abbrSpan);
    }
    card.appendChild(stats);
    return card;
  }
  function buildRankingTableRow(row, meta, rank) {
    const tr = document.createElement('tr');
    tr.dataset.games = row.games;
    tr.dataset.rd = row.rd;
    if (meta.state) tr.dataset.state = meta.state;
    if (meta.country) tr.dataset.country = meta.country;
    if (row.uncertain) tr.className = 'uncertain';
    const rankTd = document.createElement('td');
    rankTd.className = 'rank-num';
    rankTd.textContent = rank;
    tr.appendChild(rankTd);
    const nameTd = document.createElement('td');
    const nameEl = document.createElement(meta.href ? 'a' : 'span');
    if (meta.href) nameEl.href = meta.href;
    nameEl.textContent = meta.name;
    nameTd.appendChild(nameEl);
    tr.appendChild(nameTd);
    const addNumeric = (text, sort) => {
      const td = document.createElement('td');
      td.className = 'numeric';
      if (sort !== undefined) td.dataset.sort = sort;
      td.textContent = text;
      tr.appendChild(td);
    };
    addNumeric(String(row.r));
    addNumeric('±' + row.rd, row.rd);
    addNumeric(String(row.wins), row.wins);
    addNumeric(String(row.losses), row.losses);
    addNumeric(String(row.games), row.games);
    addNumeric((row.winPct * 100).toFixed(1) + '%', row.winPct);
    const lastActiveTd = document.createElement('td');
    lastActiveTd.textContent = meta.lastActive || '';
    tr.appendChild(lastActiveTd);
    const locTd = document.createElement('td');
    locTd.className = 'col-location';
    locTd.dataset.sort = meta.locationSort;
    const flagImg = prFlagImg(meta.flag, 'loc-flag');
    if (flagImg) locTd.appendChild(flagImg);
    locTd.appendChild(document.createTextNode(meta.location));
    tr.appendChild(locTd);
    return tr;
  }
  function normalizeRow(arr) {
    const [id, r, rd, wins, losses, games, isNew, placementChange] = arr;
    return {
      id, r, rd, wins, losses, games,
      winPct: games > 0 ? wins / games : 0,
      uncertain: rd > PR_UNCERTAIN_RD_THRESHOLD,
      isNew, placementChange,
    };
  }
  function renderRankingHistory(panel, checkpoint) {
    const grid = panel.querySelector('.pr-grid');
    const tbody = panel.querySelector('table tbody');
    const rows = checkpoint.rows.map(normalizeRow);
    if (grid) {
      [...grid.querySelectorAll(':scope > .pr-card')].forEach((el) => el.remove());
      rows.forEach((row, i) => grid.appendChild(buildRankingCard(row, PR_META[row.id] || {}, i + 1)));
    }
    if (tbody) {
      tbody.innerHTML = '';
      rows.forEach((row, i) => tbody.appendChild(buildRankingTableRow(row, PR_META[row.id] || {}, i + 1)));
    }
    applyFilters(panel);
    fitCardNames(panel);
  }
  function enablePrHistorySelect(panel) {
    const select = panel.querySelector('.pr-history-select');
    const label = select ? select.closest('label') : null;
    if (!select || PR_HISTORY.length < 2) {
      if (label) label.hidden = true;
      return;
    }
    for (let i = PR_HISTORY.length - 1; i >= 0; i--) {
      const checkpoint = PR_HISTORY[i];
      const opt = document.createElement('option');
      opt.value = String(i);
      const dateLabel = checkpoint.dateLabel ? checkpoint.dateLabel + ' - ' : '';
      opt.textContent = (checkpoint.isLatest ? '🕒 ' : '') + dateLabel + checkpoint.label;
      if (checkpoint.isLatest) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      const checkpoint = PR_HISTORY[parseInt(select.value, 10)];
      if (checkpoint) renderRankingHistory(panel, checkpoint);
    });
  }
  let openDropdown = null;
  const DROPDOWN_CLOSE_MS = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dropdown-close-dur')) || 150;
  const DROPDOWN_MENU_MAX_PX = 288;
  const DROPDOWN_MENU_MAX_WIDTH_PX = 416;
  const DROPDOWN_VIEWPORT_PAD = 8;
  const DROPDOWN_GAP = 4;
  let dropdownSeq = 0;
  function svgIcon(cls, viewBox, w, h, d, strokeWidth) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', strokeWidth);
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }
  function enhanceDropdown(select) {
    if (select.dataset.ddEnhanced) return;
    select.dataset.ddEnhanced = '1';
    const id = 'dd-' + (++dropdownSeq);
    const wrap = document.createElement('div');
    wrap.className = 'dd';
    wrap.dataset.for = [...select.classList].find((c) => c.endsWith('-select')) || '';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'dd-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', id + '-menu');
    const triggerFlag = document.createElement('img');
    triggerFlag.className = 'dd-flag';
    triggerFlag.alt = '';
    triggerFlag.hidden = true;
    trigger.appendChild(triggerFlag);
    const labelSpan = document.createElement('span');
    labelSpan.className = 'dd-label';
    trigger.appendChild(labelSpan);
    trigger.appendChild(svgIcon('dd-chevron', '0 0 10 6', '10', '6', 'M1 1l4 4 4-4', '1.5'));
    const menu = document.createElement('ul');
    menu.className = 'dd-menu t-dropdown';
    menu.id = id + '-menu';
    menu.setAttribute('role', 'listbox');
    menu.tabIndex = -1;
    menu.dataset.origin = 'top-left';
    const label = select.closest('label');
    if (label) {
      const text = [...label.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim().replace(/:$/, '');
      if (text) { trigger.setAttribute('aria-label', text); menu.setAttribute('aria-label', text); }
    }
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(trigger);
    wrap.appendChild(select);
    select.hidden = true;
    select.tabIndex = -1;
    document.body.appendChild(menu);
    let isOpen = false;
    let closeTimer = null;
    let activeIndex = -1;
    let typeBuffer = '';
    let typeTimer = null;
    function syncTrigger() {
      const opt = select.options[select.selectedIndex];
      labelSpan.textContent = opt ? opt.textContent : '';
      const flagSrc = opt ? opt.dataset.flag : '';
      if (flagSrc) {
        if (triggerFlag.getAttribute('src') !== flagSrc) triggerFlag.src = flagSrc;
        triggerFlag.hidden = false;
      } else {
        triggerFlag.hidden = true;
        triggerFlag.removeAttribute('src');
      }
    }
    function items() {
      return [...menu.querySelectorAll('.dd-option')];
    }
    function itemIndexOfOption(optionIndex) {
      return items().findIndex((li) => parseInt(li.dataset.index, 10) === optionIndex);
    }
    function setActive(i, scroll) {
      const list = items();
      if (!list.length) { activeIndex = -1; trigger.removeAttribute('aria-activedescendant'); return; }
      activeIndex = Math.max(0, Math.min(list.length - 1, i));
      list.forEach((li, idx) => li.classList.toggle('is-active', idx === activeIndex));
      const li = list[activeIndex];
      trigger.setAttribute('aria-activedescendant', li.id);
      if (scroll) {
        const prev = li.previousElementSibling;
        const top = prev && prev.classList.contains('dd-group') ? prev.offsetTop : li.offsetTop;
        const bottom = li.offsetTop + li.offsetHeight;
        if (top < menu.scrollTop) menu.scrollTop = top;
        else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
      }
    }
    function chooseActive() {
      const li = items()[activeIndex];
      if (li) choose(parseInt(li.dataset.index, 10));
    }
    function renderOptions() {
      menu.textContent = '';
      const addOption = (opt) => {
        const li = document.createElement('li');
        li.className = 'dd-option';
        li.id = id + '-opt-' + opt.index;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(opt.index === select.selectedIndex));
        li.dataset.index = String(opt.index);
        if (opt.dataset.flag) {
          const img = document.createElement('img');
          img.className = 'dd-flag';
          img.src = opt.dataset.flag;
          img.alt = '';
          img.loading = 'lazy';
          li.appendChild(img);
        }
        const span = document.createElement('span');
        span.className = 'dd-option-label';
        span.textContent = opt.textContent;
        li.appendChild(span);
        li.appendChild(svgIcon('dd-option-check', '0 0 12 10', '12', '10', 'M1 5.5l3.2 3L11 1.5', '1.8'));
        menu.appendChild(li);
      };
      for (const child of select.children) {
        if (child.tagName === 'OPTGROUP') {
          const head = document.createElement('li');
          head.className = 'dd-group';
          head.setAttribute('role', 'presentation');
          head.textContent = child.label;
          menu.appendChild(head);
          for (const opt of child.children) if (opt.tagName === 'OPTION') addOption(opt);
        } else if (child.tagName === 'OPTION') {
          addOption(child);
        }
      }
    }
    function position() {
      const r = trigger.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const below = vh - r.bottom - DROPDOWN_GAP - DROPDOWN_VIEWPORT_PAD;
      const above = r.top - DROPDOWN_GAP - DROPDOWN_VIEWPORT_PAD;
      menu.style.minWidth = r.width + 'px';
      menu.style.maxWidth = Math.max(r.width, Math.min(vw - DROPDOWN_VIEWPORT_PAD * 2, DROPDOWN_MENU_MAX_WIDTH_PX)) + 'px';
      menu.style.maxHeight = Math.max(96, Math.min(DROPDOWN_MENU_MAX_PX, Math.max(below, above))) + 'px';
      const mh = menu.offsetHeight, mw = menu.offsetWidth;
      const up = mh > below && above > below;
      let left = r.left;
      if (left + mw > vw - DROPDOWN_VIEWPORT_PAD) left = Math.max(DROPDOWN_VIEWPORT_PAD, vw - DROPDOWN_VIEWPORT_PAD - mw);
      const top = up ? r.top - DROPDOWN_GAP - mh : r.bottom + DROPDOWN_GAP;
      menu.style.left = left + 'px';
      menu.style.top = Math.max(DROPDOWN_VIEWPORT_PAD, top) + 'px';
      menu.dataset.origin = up ? 'bottom-left' : 'top-left';
    }
    function open() {
      if (isOpen) return;
      if (openDropdown && openDropdown !== api) openDropdown.close();
      if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      renderOptions();
      isOpen = true;
      openDropdown = api;
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      menu.classList.remove('is-closing');
      position();
      menu.classList.add('is-open');
      setActive(itemIndexOfOption(select.selectedIndex), true);
      trigger.focus();
      window.addEventListener('scroll', position, { capture: true, passive: true });
      window.addEventListener('resize', position);
    }
    function close() {
      if (!isOpen) return;
      isOpen = false;
      if (openDropdown === api) openDropdown = null;
      wrap.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      menu.classList.remove('is-open');
      menu.classList.add('is-closing');
      closeTimer = setTimeout(() => { menu.classList.remove('is-closing'); closeTimer = null; }, DROPDOWN_CLOSE_MS);
      window.removeEventListener('scroll', position, { capture: true });
      window.removeEventListener('resize', position);
    }
    function choose(i) {
      if (i < 0 || i >= select.options.length) return;
      const changed = select.selectedIndex !== i;
      select.selectedIndex = i;
      syncTrigger();
      close();
      trigger.focus();
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function typeahead(ch) {
      if (typeTimer) clearTimeout(typeTimer);
      typeTimer = setTimeout(() => { typeBuffer = ''; }, 600);
      const repeat = typeBuffer.length > 0 && typeBuffer.split('').every((c) => c === ch);
      typeBuffer += ch;
      const needle = repeat ? ch : typeBuffer;
      const list = isOpen ? items() : (renderOptions(), items());
      const labels = list.map((li) => li.querySelector('.dd-option-label').textContent.trim().toLowerCase());
      const current = isOpen ? activeIndex : itemIndexOfOption(select.selectedIndex);
      const start = current + (needle.length === 1 ? 1 : 0);
      for (let k = 0; k < labels.length; k++) {
        const idx = (start + k) % labels.length;
        if (labels[idx].startsWith(needle)) {
          if (isOpen) setActive(idx, true); else choose(parseInt(list[idx].dataset.index, 10));
          return;
        }
      }
    }
    trigger.addEventListener('click', () => { if (isOpen) close(); else open(); });
    trigger.addEventListener('keydown', (e) => {
      const n = select.options.length;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (!isOpen) open(); else setActive(activeIndex + 1, true);
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (!isOpen) open(); else setActive(activeIndex - 1, true);
          break;
        case 'Home':
          if (isOpen) { e.preventDefault(); setActive(0, true); }
          break;
        case 'End':
          if (isOpen) { e.preventDefault(); setActive(n - 1, true); }
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (isOpen) chooseActive(); else open();
          break;
        case 'Escape':
          if (isOpen) { e.preventDefault(); close(); }
          break;
        case 'Tab':
          close();
          break;
        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            typeahead(e.key.toLowerCase());
          }
      }
    });
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.addEventListener('mouseover', (e) => {
      const li = e.target.closest('.dd-option');
      if (li) setActive(items().indexOf(li), false);
    });
    menu.addEventListener('click', (e) => {
      const li = e.target.closest('.dd-option');
      if (li) choose(parseInt(li.dataset.index, 10));
    });
    new MutationObserver(() => {
      syncTrigger();
      if (isOpen) { renderOptions(); setActive(activeIndex, false); position(); }
    }).observe(select, { childList: true, subtree: true, characterData: true, attributes: true });
    syncTrigger();
    const api = { close, contains: (node) => wrap.contains(node) || menu.contains(node) || (!!label && label.contains(node)) };
    return api;
  }
  function enhanceDropdowns() {
    document.querySelectorAll('.tab-controls select').forEach(enhanceDropdown);
    document.addEventListener('pointerdown', (e) => {
      if (openDropdown && !openDropdown.contains(e.target)) openDropdown.close();
    }, true);
  }
  function initPanel(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    populateStateFilter(panel);
    applyFilters(panel);
    if (panelId === 'rankings-tab') enablePrHistorySelect(panel);
    panel.querySelectorAll('.min-games-select, .max-rd-select, .state-filter-select').forEach((el) => {
      el.addEventListener('change', () => applyFilters(panel));
    });
    enableViewToggle(panel);
    enableRankDeltaToggle(panel);
    document.fonts.ready.then(() => fitCardNames(panel));
  }
  function setupLiveEventFiltering() {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const grid = document.getElementById('events-grid');
    if (grid) {
      const cards = [...grid.querySelectorAll('.event-card[data-date]')];
      cards.forEach((card) => { card.hidden = Boolean(card.dataset.date) && card.dataset.date < today; });
      const anyVisible = cards.some((card) => !card.hidden);
      grid.hidden = !anyVisible;
      const empty = document.getElementById('events-empty');
      const footer = document.getElementById('events-footer');
      if (empty) empty.hidden = anyVisible;
      if (footer) footer.hidden = !anyVisible;
    }
    const candidatesWrap = document.getElementById('pr-square-next-candidates');
    if (candidatesWrap) {
      const candidates = [...candidatesWrap.querySelectorAll('.next-event-candidate[data-date]')];
      const chosen = candidates.find((c) => !c.dataset.date || c.dataset.date >= today);
      candidates.forEach((c) => { c.hidden = c !== chosen; });
      const single = document.getElementById('pr-square-latest-single');
      const plural = document.getElementById('pr-square-latest-plural');
      if (single) single.hidden = !chosen;
      if (plural) plural.hidden = !!chosen;
    }
  }
  document.querySelectorAll('table[data-sortable]').forEach(enableSorting);
  enableTabs();
  enableTabsMenu();
  activateTabFromQuery();
  enableOptionsToggle();
  initPanel('players-tab');
  initPanel('rankings-tab');
  enhanceDropdowns();
  enableCsvDownloadButtons();
  enableMapToggle(document.getElementById('map-tab'));
  enableMapRegions(document.getElementById('map-tab'));
  setupLiveEventFiltering();
  document.fonts.ready.then(() => {
    moveIndicator(document.querySelector('.tab-underline'), document.querySelector('.tabs'), document.querySelector('.tab-button.active'));
    document.querySelectorAll('.view-toggle').forEach((toggleEl) => {
      if (!toggleEl.offsetWidth) return;
      const indicator = toggleEl.querySelector('.view-toggle-indicator');
      const active = toggleEl.querySelector('.view-btn.active, .delta-btn.active');
      if (indicator && active) moveIndicator(indicator, toggleEl, active);
    });
  });
})();
