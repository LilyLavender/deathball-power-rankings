(function () {
  function enableSorting(table) {
    const tbody = table.tBodies[0];
    const headers = [...table.querySelectorAll('th')];
    headers.forEach((th, colIndex) => {
      th.addEventListener('click', () => {
        const asc = !th.classList.contains('sorted-asc');
        headers.forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
        th.classList.add(asc ? 'sorted-asc' : 'sorted-desc');

        const rows = [...tbody.rows];
        const type = th.dataset.type;
        rows.sort((a, b) => {
          const cellA = a.cells[colIndex];
          const cellB = b.cells[colIndex];
          let valA = cellA.dataset.sort !== undefined ? Number(cellA.dataset.sort) : cellA.textContent.trim().toLowerCase();
          let valB = cellB.dataset.sort !== undefined ? Number(cellB.dataset.sort) : cellB.textContent.trim().toLowerCase();
          if (type === 'number') return asc ? valA - valB : valB - valA;
          return asc ? String(valA).localeCompare(String(valB)) : String(valB).localeCompare(String(valA));
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

  document.querySelectorAll('table[data-sortable]').forEach(enableSorting);
  enableTabs();
})();
