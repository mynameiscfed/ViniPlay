/**
 * tablelabels.js
 * Copies each column header onto the cells below it (data-label) for tables marked .stack, so the
 * phone layout can show "Channel: ESPN" per row. Rows are rendered by several modules, so one
 * observer labels whatever lands in a tbody instead of every renderer doing it.
 */

const label = (tbody) => {
    const table = tbody.closest('table.stack');
    if (!table) return;
    const heads = [...table.querySelectorAll('thead th')].filter(th => !th.classList.contains('hidden'));
    tbody.querySelectorAll('tr').forEach(tr => {
        const cells = [...tr.children];
        // A single cell spanning the table is a message row ("No recordings"), not data.
        if (cells.length === 1 && cells[0].colSpan > 1) return;
        cells.forEach((td, i) => {
            const text = heads[i]?.textContent.trim();
            if (text && td.dataset.label !== text) td.dataset.label = text;
        });
    });
};

export function initTableLabels() {
    const observer = new MutationObserver((records) => {
        for (const r of records) {
            const tbody = r.target.closest?.('tbody');
            if (tbody) label(tbody);
        }
    });
    document.querySelectorAll('table.stack tbody').forEach(tbody => {
        label(tbody);
        observer.observe(tbody, { childList: true });
    });
}
