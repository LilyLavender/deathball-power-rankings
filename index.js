(function () {
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

  function enableTabs() {
    const buttons = [...document.querySelectorAll('.tab-button')];
    const panels = [...document.querySelectorAll('.tab-panel')];
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.classList.remove('active'));
        panels.forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
      });
    });
  }

  function enableRankingsFilter() {
    const panel = document.getElementById('rankings-tab');
    if (!panel) return;
    const select = panel.querySelector('.min-games-select');
    const tbody = panel.querySelector('table tbody');
    const countEl = panel.querySelector('.ranking-count');
    if (!select || !tbody) return;

    function applyFilter() {
      const minGames = parseInt(select.value, 10) || 0;
      let rank = 1;
      let count = 0;
      for (const row of tbody.rows) {
        const games = parseInt(row.dataset.games, 10);
        const show = !isNaN(games) && games >= minGames;
        row.hidden = !show;
        if (show) {
          row.cells[0].textContent = rank++;
          count++;
        }
      }
      if (countEl) countEl.textContent = count + ' players ranked.';
    }

    select.addEventListener('change', applyFilter);
    applyFilter();
  }

  document.querySelectorAll('table[data-sortable]').forEach(enableSorting);
  enableTabs();
  enableRankingsFilter();
})();
