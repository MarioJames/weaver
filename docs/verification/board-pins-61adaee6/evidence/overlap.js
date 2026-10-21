(() => {
  const res = { cards: 0, overlaps: [] };
  document.querySelectorAll('[data-status-column] [aria-pressed]').forEach(btn => {
    const shell = btn.parentElement; const card = shell.firstElementChild; const pr = btn.getBoundingClientRect();
    res.cards++;
    const hit = (r) => !(r.right <= pr.left || r.left >= pr.right || r.bottom <= pr.top || r.top >= pr.bottom);
    // every text node and tag inside the card button
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    let n; const rects = [];
    while ((n = walker.nextNode())) { if (!n.textContent.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(n); rects.push(...rg.getClientRects()); }
    card.querySelectorAll('span, svg, strong').forEach(e => { if (e.children.length === 0) rects.push(e.getBoundingClientRect()); });
    const bad = rects.filter(r => r.width > 0 && r.height > 0 && hit(r));
    if (bad.length) res.overlaps.push(card.querySelector('strong')?.textContent);
  });
  return JSON.stringify(res);
})()
