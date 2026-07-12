(function () {
  const STATE_NAMES = {"AL":"Alabama","AK":"Alaska","AZ":"Arizona","AR":"Arkansas","CA":"California","CO":"Colorado","CT":"Connecticut","DE":"Delaware","FL":"Florida","GA":"Georgia","HI":"Hawaii","ID":"Idaho","IL":"Illinois","IN":"Indiana","IA":"Iowa","KS":"Kansas","KY":"Kentucky","LA":"Louisiana","ME":"Maine","MD":"Maryland","MA":"Massachusetts","MI":"Michigan","MN":"Minnesota","MS":"Mississippi","MO":"Missouri","MT":"Montana","NE":"Nebraska","NV":"Nevada","NH":"New Hampshire","NJ":"New Jersey","NM":"New Mexico","NY":"New York","NC":"North Carolina","ND":"North Dakota","OH":"Ohio","OK":"Oklahoma","OR":"Oregon","PA":"Pennsylvania","RI":"Rhode Island","SC":"South Carolina","SD":"South Dakota","TN":"Tennessee","TX":"Texas","UT":"Utah","VT":"Vermont","VA":"Virginia","WA":"Washington","WV":"West Virginia","WI":"Wisconsin","WY":"Wyoming","DC":"Washington D.C.","AB":"Alberta","BC":"British Columbia","MB":"Manitoba","NB":"New Brunswick","NL":"Newfoundland and Labrador","NS":"Nova Scotia","NT":"Northwest Territories","NU":"Nunavut","ON":"Ontario","PE":"Prince Edward Island","QC":"Quebec","SK":"Saskatchewan","YT":"Yukon"};
  const MAP_REGION_DATA = JSON.parse(document.getElementById('map-region-data')?.textContent || '{}');
  const PR_HISTORY_DATA = JSON.parse(document.getElementById('pr-history-data')?.textContent || '{}');
  const PR_META = PR_HISTORY_DATA.players || {};
  const PR_HISTORY = PR_HISTORY_DATA.checkpoints || [];
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

  // Positions indicator (a .tab-underline or .view-toggle-indicator) to
  // sit under/behind target within container, sized to match — called on
  // init and again on every switch so it slides there via the element's
  // own CSS transition instead of just appearing in the new spot.
  function moveIndicator(indicator, container, target) {
    if (!indicator || !container || !target) return;
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    indicator.style.left = (targetRect.left - containerRect.left) + 'px';
    indicator.style.width = targetRect.width + 'px';
  }

  const TAB_HEADERS = { 'players-tab': 'Players', 'tournaments-tab': 'Tournaments', 'rankings-tab': 'Power Rankings', 'map-tab': 'Map', 'events-tab': 'Upcoming Events' };

  // Cross-fades just the variable part of the page heading ("DeathBall" is
  // static) to the tab's own heading instead of snapping straight to it.
  function setHeaderForTab(tabId) {
    const heading = document.getElementById('tab-heading');
    const label = TAB_HEADERS[tabId] || TAB_HEADERS['rankings-tab'];
    if (!heading || heading.textContent === label) return;
    heading.classList.add('h1-swap');
    setTimeout(() => {
      heading.textContent = label;
      heading.classList.remove('h1-swap');
    }, 180);
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
        // Cards were sized while this panel was display:none (offsetWidth 0
        // at page load, or never resized since last becoming visible), so
        // names need a fresh fit now that the panel actually has layout.
        fitCardNames(panel);
        // Same story for any view-toggle pill(s) inside this panel (e.g. the
        // Map tab's Players/Tournaments switch, or the Rankings tab's
        // Grid/Table and rank-delta Hide/Show switches) — indicators were
        // positioned against a zero-width rect while hidden.
        for (const innerToggle of panel.querySelectorAll('.view-toggle')) {
          const innerIndicator = innerToggle.querySelector('.view-toggle-indicator');
          const innerActive = innerToggle.querySelector('.view-btn.active, .delta-btn.active');
          if (innerIndicator && innerActive) moveIndicator(innerIndicator, innerToggle, innerActive);
        }
      });
    });
    moveIndicator(underline, tabsEl, buttons.find((b) => b.classList.contains('active')));
  }

  function populateStateFilter(panel) {
    const select = panel.querySelector('.state-filter-select');
    const tbody = panel.querySelector('table tbody');
    if (!select || !tbody) return;
    const seen = new Set();
    for (const row of tbody.rows) {
      if (row.dataset.state) seen.add(row.dataset.state);
    }
    const sorted = [...seen].sort((a, b) =>
      (STATE_NAMES[a] || a).localeCompare(STATE_NAMES[b] || b)
    );
    for (const abbr of sorted) {
      const opt = document.createElement('option');
      opt.value = abbr;
      opt.dataset.label = STATE_NAMES[abbr] || abbr;
      opt.textContent = opt.dataset.label;
      select.appendChild(opt);
    }
    // Stamp base label on the hardcoded "All locations" option too
    if (select.options[0]) select.options[0].dataset.label = select.options[0].textContent;
  }

  function applyFilters(panel) {
    const minGames = parseInt(panel.querySelector('.min-games-select')?.value || '0', 10);
    const maxRdVal = panel.querySelector('.max-rd-select')?.value || 'Infinity';
    const maxRd = maxRdVal === 'Infinity' ? Infinity : parseFloat(maxRdVal);
    const state = panel.querySelector('.state-filter-select')?.value || '';
    const tbody = panel.querySelector('table tbody');
    const isRankingsTab = panel.id === 'rankings-tab';
    const DEFAULT_MIN_GAMES = 5;
    const DEFAULT_MAX_RD = 150;

    // Use card grid as count source for rankings (avoids double-counting with table).
    // Scoped to direct .pr-card children so the .pr-square promo tile (no
    // data-games/data-rd, not a real ranked player) is never counted, ranked,
    // or hidden by these filters.
    const grid = isRankingsTab ? panel.querySelector('.pr-grid') : null;
    const countSource = grid ? [...grid.querySelectorAll(':scope > .pr-card')] : (tbody ? [...tbody.rows] : []);

    // First pass: count per state for items passing non-state filters
    const stateCounts = new Map();
    let totalPassingNonState = 0;
    for (const el of countSource) {
      const games = parseInt(el.dataset.games || '0', 10);
      const rd = parseFloat(el.dataset.rd || '0');
      if (minGames && games < minGames) continue;
      if (maxRd !== Infinity && rd > maxRd) continue;
      const rowState = el.dataset.state || '';
      stateCounts.set(rowState, (stateCounts.get(rowState) || 0) + 1);
      totalPassingNonState++;
    }

    // Update dropdown option labels with counts
    const stateSelect = panel.querySelector('.state-filter-select');
    if (stateSelect) {
      for (const opt of stateSelect.options) {
        const label = opt.dataset.label || opt.textContent.replace(/\s*\(\d+\)$/, '');
        const count = opt.value === '' ? totalPassingNonState : (stateCounts.get(opt.value) || 0);
        opt.textContent = label + ' (' + count + ')';
      }
    }

    // Apply filters to table rows
    if (tbody) {
      let rank = 1;
      for (const row of tbody.rows) {
        const games = parseInt(row.dataset.games || '0', 10);
        const rd = parseFloat(row.dataset.rd || '0');
        const rowState = row.dataset.state || '';
        const passesMinMax = (!minGames || games >= minGames) && (maxRd === Infinity || rd <= maxRd);
        const passesState = !state || rowState === state;
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

    // Apply filters to card grid (rankings tab only)
    let visible = 0;
    if (grid) {
      let rank = 1;
      for (const card of grid.querySelectorAll(':scope > .pr-card')) {
        const games = parseInt(card.dataset.games || '0', 10);
        const rd = parseFloat(card.dataset.rd || '0');
        const cardState = card.dataset.state || '';
        const passesMinMax = (!minGames || games >= minGames) && (maxRd === Infinity || rd <= maxRd);
        const passesState = !state || cardState === state;
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
      // The sort hint only applies while the sortable table is actually the
      // visible view — grid mode has no columns to click.
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

  // Sequential fill scale from dim (no data) up to bright green, using a
  // sqrt scale so a handful of high-count hubs (e.g. Texas/Minnesota) don't
  // wash out every other state to the same dim shade.
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
        // Keep an open region's sidebar in sync with whichever list (players
        // vs tournaments) is now the active view, without touching zoom.
        if (panel._mapRefreshSidebar) panel._mapRefreshSidebar();
      });
    });
    const active = buttons.find((b) => b.classList.contains('active'));
    moveIndicator(indicator, toggleEl, active);
    updateMap(panel, active ? active.dataset.view : 'players');
  }

  function animateViewBox(svg, toBox, duration) {
    const fromBox = svg.getAttribute('viewBox').split(' ').map(Number);
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const box = fromBox.map((v, i) => v + (toBox[i] - v) * eased);
      svg.setAttribute('viewBox', box.join(' '));
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Mirrors the player page's tournament-history-list / recent-matches-list
  // styling (standings-list / standings-rank / hist-tourney-name /
  // standings-record) so this reads as the same kind of list elsewhere on
  // the site, rather than a one-off sidebar design. The sidebar always
  // shows a list — regionId '__ALL__' (the default) shows every
  // player/tournament; clicking a region filters this same list down
  // rather than swapping in a separate view.
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
    (isTournaments ? ['Tournament', 'Date'] : ['Player', 'Placement', 'Rating', 'Last Active']).forEach((label) => {
      const span = document.createElement('span');
      span.textContent = label;
      colhead.appendChild(span);
    });

    list.innerHTML = '';
    const items = isTournaments ? data.tournamentsList : data.playersList;
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
        rankSpan.textContent = '#' + item.rank;
        li.appendChild(rankSpan);
        const ratingSpan = document.createElement('span');
        ratingSpan.className = 'standings-record';
        ratingSpan.textContent = item.v + ' ± ' + item.rd;
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

  function enableMapRegions(panel) {
    if (!panel) return;
    const svg = panel.querySelector('.map-svg');
    const regions = [...panel.querySelectorAll('.map-region')];
    const backBtn = panel.querySelector('.map-sidebar-back');
    let selectedId = '__ALL__';

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

    regions.forEach((r) => {
      r.addEventListener('click', () => {
        if (selectedId === r.dataset.id) { deselect(); return; }
        regions.forEach((other) => other.classList.remove('selected'));
        r.classList.add('selected');
        selectedId = r.dataset.id;
        zoomToRegion(svg, r);
        renderMapSidebar(panel, selectedId, currentView());
      });
    });
    if (backBtn) backBtn.addEventListener('click', deselect);

    // Sidebar always shows a list (the full unfiltered one by default), so
    // populate it immediately rather than waiting for a region click.
    renderMapSidebar(panel, selectedId, currentView());

    panel._mapRefreshSidebar = () => renderMapSidebar(panel, selectedId, currentView());
  }

  // html2canvas draws cross-origin <img> elements (CDN flags, the square's
  // logo) via a raw ctx.drawImage, which silently no-ops on a tainted
  // source instead of throwing -- the image just never appears. Pre-fetch
  // each one and swap its src for a same-origin data: URI before capture
  // sidesteps that entirely (see downloadRankingsImage).
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
        // Leave the original src; ignoreElements below drops it from the
        // render instead of leaving a broken/cross-origin image in place.
      }
    }));
  }

  // html2canvas doesn't honor object-fit on <img> (a longstanding upstream
  // limitation) -- it just stretches the source bitmap to fill the element's
  // full box, ignoring .prc-flag's object-fit: contain. Live, that CSS
  // letterboxes each flag to its own real aspect ratio inside the 1.5em x
  // 1.15em box (so e.g. the UK flag's wider ~2:1 shape renders smaller than
  // the box rather than stretched to fill it); in the export every flag was
  // instead coming out uniformly squashed to the box's own ~1.3:1 shape.
  // Bake the same contain math into real pixels instead: draw each flag
  // (already same-origin after inlineImages) onto a canvas sized to the
  // box's own rendered dimensions, scaled/centered exactly like
  // object-fit: contain would, and swap the <img> src for that -- so the
  // stretch has nothing left to distort. Must run after inlineImages (needs
  // a decodable same-origin/data: src) and after the clone is attached with
  // its final layout (needs real getBoundingClientRect() sizes).
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

  // Captures the top 100 ranked cards passing the default min-games/max-RD
  // filter (same 5+/<=150 thresholds as the default view, regardless of
  // whatever the live min-games/max-RD/state selects are currently set to)
  // plus the .pr-square promo tile into an offscreen clone forced to the
  // 8-column desktop layout, so the exported image is consistent regardless
  // of the current viewport width or filter state.
  async function downloadRankingsImage(panel) {
    const grid = panel.querySelector('.pr-grid');
    if (!grid || !window.html2canvas) throw new Error('Power Ranking grid or html2canvas unavailable');
    // Custom fonts may not have finished loading yet, and this also ensures
    // the metrics fitCardNames() measures below are accurate.
    await document.fonts.ready;
    const square = grid.querySelector('.pr-square');
    const qualifying = [...grid.querySelectorAll(':scope > .pr-card')].filter((c) => {
      const games = parseInt(c.dataset.games || '0', 10);
      const rd = parseFloat(c.dataset.rd || '0');
      return games >= 5 && rd <= 150;
    });
    const cards = qualifying.slice(0, 100);
    const clone = document.createElement('div');
    // Carries the live rank-delta toggle state along into the export --
    // .show-rank-delta isn't #rankings-tab-scoped specifically so this plain
    // <body> child can match it too (see the CSS rule for why).
    clone.className = 'pr-grid pr-export-grid' + (panel.classList.contains('show-rank-delta') ? ' show-rank-delta' : '');
    clone.style.gridTemplateColumns = 'repeat(8, 1fr)';
    // Pinned to this specific width (rather than the live grid's current
    // width) so every download comes out identically sized -- this is
    // whatever .pr-grid measured on the developer's own screen, not a
    // computed/responsive value. Retune by hand if it ever needs to change.
    // box-sizing is forced back to content-box here (overriding the site's
    // global * { box-sizing: border-box } reset) so this width is the actual
    // content/column width, matching .pr-grid's own measured width exactly --
    // otherwise the padding below would eat into it and every card would
    // render slightly narrower than the live site's.
    clone.style.boxSizing = 'content-box';
    clone.style.width = '1472px';
    clone.style.padding = '24px';
    clone.style.background = '#050505';
    if (square) {
      const squareClone = square.cloneNode(true);
      squareClone.style.display = 'flex';
      clone.appendChild(squareClone);
    }
    // Cards already passed the games/RD check above, but may still carry a
    // hidden attribute from a live state-filter selection (cloneNode
    // preserves it, and left alone it'd collapse the clone to zero size) --
    // force every one of the top 100 visible and renumbered 1-100, since the
    // export always shows all locations regardless of the live state filter.
    cards.forEach((c, idx) => {
      const cardClone = c.cloneNode(true);
      cardClone.hidden = false;
      cardClone.classList.remove('filter-dim', 'uncertain');
      // Only the numeral, not the whole .prc-rank -- that would also wipe
      // out the sibling .rank-delta badge (and rank-plain's color class),
      // which should survive the renumbering since the rating-point change
      // it shows isn't tied to rank position.
      const rankEl = cardClone.querySelector('.prc-rank .rank-plain');
      if (rankEl) rankEl.textContent = idx + 1;
      clone.appendChild(cardClone);
    });
    document.body.appendChild(clone);
    // html2canvas's own gradient renderer doesn't size a radial-gradient's
    // implicit farthest-corner extent correctly (tried it explicit, tried an
    // explicit percentage size, tried hand-deriving and painting the
    // ellipse ourselves via Canvas2D -- none matched the live page's actual
    // rendered gradient). Instead of reimplementing it at all, literally
    // copy the real thing: render an actual .pr-card.card-green/.card-purple
    // through an SVG foreignObject, which uses the browser's own genuine CSS
    // engine (not a reimplementation), rasterize that to a bitmap, and use
    // it as a background-image -- html2canvas draws real images reliably,
    // just not live CSS gradients.
    const glowCache = {};
    // Same as .pr-card.card-green/.card-purple's CSS -- inlined directly
    // rather than referenced by class, since the foreignObject below is
    // serialized to a standalone SVG document with no access to the page's
    // external stylesheet (a class name alone rendered with no styling at
    // all, confirmed by sampling the result: flat, no color whatsoever).
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
    // cloneNode copies each name's live inline font-size (set by
    // fitCardNames() against the ORIGINAL grid's column width) verbatim --
    // that size is wrong whenever the live grid's current width doesn't
    // match this clone's pinned export width, so names clipped fine on-page
    // can overflow their card here. Re-fit against the clone's actual width
    // now that it's attached to the DOM.
    fitCardNames(clone);
    await inlineImages(clone);
    await bakeFlagAspect(clone);
    // Not wrapped in try/finally -- the caller (the download button's click
    // handler) needs a genuine rejection on failure so it knows to flip back
    // to a clickable, non-"loading" state rather than staying stuck.
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
      a.download = 'deathball-power-rankings-top100.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      clone.remove();
    }
  }

  function enableViewToggle(panel) {
    const buttons = [...panel.querySelectorAll('.view-btn')];
    if (!buttons.length) return;
    const grid = panel.querySelector('.pr-grid');
    const table = panel.querySelector('table');
    const toggleEl = panel.querySelector('.view-toggle');
    const indicator = panel.querySelector('.view-toggle-indicator');
    const downloadBtn = panel.querySelector('.download-btn');
    // The rank-delta badge only ever exists in the card markup (see
    // rankDeltaHtml's call sites), so its show/hide pill is meaningless --
    // and would sit there inert -- once the Table view is active.
    const rankDeltaToggle = panel.querySelector('.rank-delta-toggle');
    // Loading state disables the button entirely (so a second click can't
    // start a second concurrent export mid-generation, which is otherwise
    // easy to trigger since generation takes a couple of seconds and gave
    // no visible feedback before this). A failed attempt clears back to the
    // normal enabled state (not "loading") so the button is clickable again
    // to retry, rather than getting stuck disabled forever.
    const downloadLabel = downloadBtn ? downloadBtn.querySelector('.download-btn-label') : null;
    if (downloadBtn) downloadBtn.addEventListener('click', async () => {
      if (downloadBtn.disabled) return;
      downloadBtn.disabled = true;
      downloadBtn.classList.remove('failed');
      downloadBtn.classList.add('loading');
      if (downloadLabel) downloadLabel.textContent = 'Preparing…';
      try {
        await downloadRankingsImage(panel);
        if (downloadLabel) downloadLabel.textContent = 'Download PR';
      } catch (err) {
        downloadBtn.classList.add('failed');
        if (downloadLabel) downloadLabel.textContent = 'Failed — Retry';
      } finally {
        downloadBtn.disabled = false;
        downloadBtn.classList.remove('loading');
      }
    });
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.dataset.view;
        if (grid) grid.style.display = view === 'grid' ? '' : 'none';
        if (table) table.style.display = view === 'table' ? '' : 'none';
        if (downloadBtn) downloadBtn.hidden = view !== 'grid';
        if (rankDeltaToggle) rankDeltaToggle.hidden = view !== 'grid';
        moveIndicator(indicator, toggleEl, btn);
        // Also refreshes the "Click a column header to sort." hint for the
        // view just switched to.
        applyFilters(panel);
      });
    });
    const activeBtn = buttons.find((b) => b.classList.contains('active'));
    if (downloadBtn) downloadBtn.hidden = !activeBtn || activeBtn.dataset.view !== 'grid';
    if (rankDeltaToggle) rankDeltaToggle.hidden = !activeBtn || activeBtn.dataset.view !== 'grid';
    moveIndicator(indicator, toggleEl, activeBtn);
  }

  // Show/Hide pill for the rank-delta (up/down/new) badge on Power Ranking
  // cards -- see #rankings-tab.show-rank-delta in the generated CSS, which
  // is the only thing that actually reveals .rank-delta. Off by default
  // (see the "hide" button's initial "active" class in writeHtml()) so the
  // badge doesn't compete for attention on the grid every time.
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

  // Rebuilds .pr-card/.pr-card accents and the rank-delta badge from raw
  // row data -- mirrors cardAccent()/rankDeltaState()/rankDeltaHtml() in
  // aggregate_players.js. Kept in sync by hand: the "View rankings at"
  // dropdown (PR_HISTORY, see enablePrHistorySelect below) only ships each
  // checkpoint's *data*, not pre-rendered HTML, so switching checkpoints
  // re-renders the grid/table client-side the same way the map tab's
  // sidebar re-renders from MAP_REGION_DATA.
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

    const locTd = document.createElement('td');
    locTd.className = 'col-location';
    locTd.dataset.sort = meta.locationSort;
    const flagImg = prFlagImg(meta.flag, 'loc-flag');
    if (flagImg) locTd.appendChild(flagImg);
    locTd.appendChild(document.createTextNode(meta.location));
    tr.appendChild(locTd);

    return tr;
  }

  // Mirrors toClientRow()'s array order in aggregate_players.js:
  // [id, r, rd, wins, losses, games, isNew, placementChange]. winPct/uncertain
  // aren't shipped (cheap to recompute) so they're filled back in here.
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

  // Populates the Rankings tab's "View rankings at" dropdown from PR_HISTORY
  // (one entry per tournament group, chronological) -- most-recent first,
  // with a clock icon marking the current/latest entry. Selecting an older
  // entry swaps the grid/table to that point-in-time standings; filters and
  // the download button both operate on whatever's currently rendered, so
  // they keep working unchanged.
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

  // Both the Events tab grid and the pr-square's "Next Tournament" callout
  // are baked at generation time using the build machine's today (see
  // sortedUpcomingEvents() / buildEventsTabHtml() in aggregate_players.js).
  // If the site isn't regenerated the same day an event's date passes, the
  // static HTML still shows it as upcoming. Re-filter both against the
  // *visitor's* today here so a stale build still self-corrects in the
  // browser instead of waiting on a rebuild.
  function setupLiveEventFiltering() {
    // Built from local date parts, not toISOString(), for the same reason
    // as todayIso() server-side: UTC parsing can read as tomorrow/yesterday
    // depending on the visitor's timezone.
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const grid = document.getElementById('events-grid');
    if (grid) {
      const cards = [...grid.querySelectorAll('.event-card[data-date]')];
      cards.forEach((card) => { card.hidden = card.dataset.date < today; });
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
      const chosen = candidates.find((c) => c.dataset.date >= today);
      candidates.forEach((c) => { c.hidden = c !== chosen; });
      const single = document.getElementById('pr-square-latest-single');
      const plural = document.getElementById('pr-square-latest-plural');
      if (single) single.hidden = !chosen;
      if (plural) plural.hidden = !!chosen;
    }
  }

  document.querySelectorAll('table[data-sortable]').forEach(enableSorting);
  enableTabs();
  initPanel('players-tab');
  initPanel('rankings-tab');
  enableMapToggle(document.getElementById('map-tab'));
  enableMapRegions(document.getElementById('map-tab'));
  setupLiveEventFiltering();

  // Every indicator above was positioned/sized against whatever font was
  // rendering at that moment — on first paint that's often the fallback
  // font, since Rajdhani/Orbitron load async, so the underline/pill can end
  // up too wide or narrow until something else (a click) recomputes it.
  // Re-measure the tab underline and any currently-visible view-toggle pill
  // once the real fonts are in so page load always lands on the right size.
  document.fonts.ready.then(() => {
    moveIndicator(document.querySelector('.tab-underline'), document.querySelector('.tabs'), document.querySelector('.tab-button.active'));
    document.querySelectorAll('.view-toggle').forEach((toggleEl) => {
      if (!toggleEl.offsetWidth) return; // hidden panel — its own tab click handler will fix this when it opens
      const indicator = toggleEl.querySelector('.view-toggle-indicator');
      const active = toggleEl.querySelector('.view-btn.active, .delta-btn.active');
      if (indicator && active) moveIndicator(indicator, toggleEl, active);
    });
  });
})();
