(() => {
  const out = {};
  document.querySelectorAll('[data-status-column]').forEach(col => {
    const key = col.dataset.statusColumn;
    const head = col.querySelector('header');
    const rows = [];
    col.querySelectorAll('h3, [aria-pressed], div').forEach(() => {});
    const walker = col.querySelectorAll('*');
    for (const el of walker) {
      if (el.tagName === 'H3') rows.push('H:' + el.textContent.trim());
      else if (el.tagName === 'DIV' && el.children.length === 2 && /^置顶 · \d+$/.test(el.textContent.trim()) && el.querySelector('svg') && !el.querySelector('button')) rows.push('Z:' + el.textContent.trim());
      else if (el.tagName === 'DIV' && el.querySelector(':scope > button[aria-pressed]')) {
        const b = el.querySelector(':scope > button[aria-pressed]');
        const card = el.firstElementChild;
        const title = card.querySelector('strong')?.textContent;
        const isNew = [...card.querySelectorAll('span')].some(s => s.textContent.trim() === '新' && s.children.length === 0 || (s.className.includes('tag') && s.textContent.trim()==='新'));
        rows.push('C:' + title + (isNew ? ' [新]' : '') + ' pressed=' + b.getAttribute('aria-pressed') + ' label=' + b.getAttribute('aria-label'));
      }
    }
    const btn = [...col.querySelectorAll('button')].filter(b => /^(查看全部|收起)/.test(b.textContent.trim())).map(b => b.textContent.trim());
    out[key] = { head: head?.textContent.trim(), collapsed: col.dataset.collapsed, rows, viewAll: btn };
  });
  return JSON.stringify(out, null, 1);
})()
