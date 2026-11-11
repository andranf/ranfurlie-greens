/* Greens Live add-ons (v1, 11 Nov 2026). Loaded by index.html with one <script> tag.
   1. Data sources: adds SkimTurf and TurfRad rows (latest date held on the dashboard) and an amber
      line in the header when either has gone quiet, so a feed can't lapse without showing.
   2. Soil tab: "Irrigation water by site" card from water_sites.json (Turf Forensics, six sample sites),
      rated on the same FAO-29 limits as the dam table above it.
   Everything here is additive: it reads window.dash and never changes the page's own panels. */
(function () {
  'use strict';
  var D = window.dash;
  if (!D || !D.data || !document.getElementById('sources')) return;

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function rows(id) { try { var r = D.data(id); return (r && r.data) || []; } catch (e) { return []; } }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function melToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function daysSince(ymd) { return Math.round((Date.parse(melToday() + 'T00:00:00Z') - Date.parse(ymd + 'T00:00:00Z')) / 864e5); }
  function dm(ymd) { var p = ymd.split('-'); return (+p[2]) + ' ' + MON[+p[1] - 1]; }
  function maxDate(list, key) {
    var m = '';
    list.forEach(function (r) { var d = String(r[key] || '').slice(0, 10); if (/^\d{4}-\d\d-\d\d$/.test(d) && d > m) m = d; });
    return m;
  }

  var css = document.createElement('style');
  css.textContent =
    '#src-quiet{margin-top:.5rem;padding:.45rem .75rem;border-radius:8px;font-weight:600;font-size:var(--cds-font-size-caption,13px);line-height:1.4;' +
    'background:color-mix(in srgb,var(--color-warn) 16%,transparent);color:var(--color-warn)}' +
    '#card-wsites .ws-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:.6rem}' +
    '#card-wsites table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}' +
    '#card-wsites th,#card-wsites td{padding:.38rem .45rem;text-align:left;border-bottom:1px solid var(--color-border-line);white-space:nowrap}' +
    '#card-wsites th.n,#card-wsites td.n{text-align:right}' +
    '#card-wsites td.p{white-space:normal;min-width:8.5rem}' +
    '#card-wsites .up{color:var(--color-warn)}#card-wsites .dn{color:var(--color-ok)}#card-wsites .fl{color:var(--color-fg-muted)}' +
    '#card-wsites .ws-chip{font-size:var(--cds-font-size-caption,12.5px);font-weight:600}' +
    '#card-wsites .ws-btns{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;margin-top:.7rem;padding-bottom:2px}' +
    '#card-wsites .ws-btns::-webkit-scrollbar{display:none}' +
    '#card-wsites .ws-btns button{flex:none;border:1px solid var(--color-border-line);background:transparent;color:inherit;border-radius:99px;padding:.34rem .75rem;font:inherit;font-size:var(--cds-font-size-caption,13px);font-weight:600;cursor:pointer}' +
    '#card-wsites .ws-btns button[aria-pressed="true"]{background:var(--color-fg);color:var(--color-bg);border-color:var(--color-fg)}' +
    '#card-wsites .rg-wq-top{margin-top:.7rem}#card-wsites .st .v{font-size:1.15rem;font-weight:700;line-height:1.25}' +
    '#card-wsites .st .s{font-size:var(--cds-font-size-caption,12.5px);color:var(--color-fg-muted)}';
  document.head.appendChild(css);

  /* ---------- 1. source freshness ---------- */
  function feeds() {
    var skim = maxDate(rows('skimturf'), 'date'), sat = rows('sat_moist')[0];
    if (sat && sat.last_pass && String(sat.last_pass).slice(0, 10) > skim) skim = String(sat.last_pass).slice(0, 10);
    return [
      { id: 'skim', source: 'SkimTurf', feeds: 'Fairway stress, satellite moisture, nutrients', latest: skim, quietAfter: 14,
        hit: 'Fairway stress, satellite moisture and nutrient layers are that old.' },
      { id: 'tr', source: 'TurfRad', feeds: 'Greens and fairway moisture scans', latest: maxDate(rows('turfrad'), 'date'), quietAfter: 4,
        hit: 'Greens moisture, the Map and TurfRad tabs are that old.' }
    ].filter(function (f) { return f.latest; });
  }
  var busy = false;
  function paintSources() {
    var ul = document.getElementById('sources');
    if (!ul || busy || !ul.children.length) return;
    busy = true;
    Array.prototype.slice.call(ul.querySelectorAll('li[data-x]')).forEach(function (n) { n.remove(); });
    var quiet = [];
    feeds().forEach(function (f) {
      var age = daysSince(f.latest), old = age > f.quietAfter;
      var li = el('li'); li.setAttribute('data-x', f.id);
      var mid = el('span');
      mid.append(el('span', 'rg-src-n', f.source), el('span', 'rg-src-f', ' · ' + f.feeds + ' · latest on the dashboard' + (old ? ', ' + age + ' days old' : '')));
      var d = el('span', 'rg-src-d' + (old ? ' rg-bad' : ''), 'to ' + dm(f.latest));
      li.append(el('span', 'rg-dot ' + (old ? 'out' : 'live')), mid, d);
      ul.appendChild(li);
      if (old) quiet.push(f.source + ': nothing new since ' + dm(f.latest) + ' (' + age + ' days). ' + f.hit);
    });
    var bn = document.getElementById('src-quiet'), anchor = document.getElementById('stale-bn');
    if (quiet.length && anchor) {
      if (!bn) { bn = el('div'); bn.id = 'src-quiet'; bn.setAttribute('role', 'status'); anchor.parentNode.insertBefore(bn, anchor.nextSibling); }
      bn.textContent = quiet.join(' ');
    } else if (bn) bn.remove();
    busy = false;
  }
  var srcUl = document.getElementById('sources');
  if (window.MutationObserver) new MutationObserver(function () {
    if (!busy && !srcUl.querySelector('li[data-x]')) setTimeout(paintSources, 0);
  }).observe(srcUl, { childList: true });

  /* ---------- 2. irrigation water by site ---------- */
  var W = null, pick = 'all';
  var KEY = ['pH', 'EC', 'SAR', 'adjSAR', 'Na', 'Cl', 'HCO3', 'Gypsum'];
  function infil(sar, ec) {
    var b = [[3, 0.7, 0.2], [6, 1.2, 0.3], [12, 1.9, 0.5], [20, 2.9, 1.3], [40, 5.0, 2.9]];
    for (var i = 0; i < b.length; i++) if (sar <= b[i][0]) return ec > b[i][1] ? 'none' : ec < b[i][2] ? 'severe' : 'slight-moderate';
    return 'severe';
  }
  // FAO-29 limits, the same ones the dam table uses. Returns [rating, what it rates] or null.
  function rate(k, v, i) {
    var x = v[k][i];
    if (k === 'pH') return [x >= 6.5 && x <= 8.4 ? 'normal' : 'outside 6.5-8.4', 'pH'];
    if (k === 'EC') return [x < 0.7 ? 'none' : x <= 3 ? 'slight-moderate' : 'severe', 'salinity (crop)'];
    if (k === 'SAR') return [infil(x, v.EC[i]), 'infiltration (SAR v EC)'];
    if (k === 'Na') { var na = x / 22.99; return [na < 3 ? 'none' : 'slight-moderate', 'foliar sodium (overhead), ' + na.toFixed(2) + ' meq/L']; }
    if (k === 'Cl') { var cl = x / 35.45; return [cl < 3 ? 'none' : 'slight-moderate', 'foliar chloride (overhead), ' + cl.toFixed(2) + ' meq/L']; }
    if (k === 'HCO3') { var h = x / 61.02; return [h < 1.5 ? 'none' : h <= 8.5 ? 'slight-moderate' : 'severe', 'bicarbonate, ' + h.toFixed(2) + ' meq/L']; }
    if (k === 'B') return [x < 0.7 ? 'none' : x <= 3 ? 'slight-moderate' : 'severe', 'boron'];
    return null;
  }
  function rateCol(r) { return /none|normal|safe/.test(r) ? 'var(--color-ok)' : /slight|margina/.test(r) ? 'var(--color-warn)' : 'var(--color-bad)'; }
  function fmt(x, k) { var p = k && label(k); return p && p.d != null ? x.toFixed(p.d) : String(+x.toFixed(2)); }
  function delta(a, b) {
    var s = el('span', 'rg-note');
    if (Math.abs(b - a) < 1e-9) { s.textContent = ' ='; s.className += ' fl'; return s; }
    s.textContent = b > a ? ' ▲' : ' ▼'; return s;
  }
  function chip(r) { var c = el('span', 'rg-chip ws-chip', r); c.style.color = rateCol(r); return c; }
  function label(k) { var p = W.params.filter(function (p) { return p.k === k; })[0]; return p ? p : { k: k, label: k, unit: '' }; }
  function range(k) {
    var lo = null, hi = null;
    W.sites.forEach(function (s) { var x = s.v[k][1]; if (!lo || x < lo.x) lo = { x: x, n: s.name }; if (!hi || x > hi.x) hi = { x: x, n: s.name }; });
    return { lo: lo, hi: hi };
  }
  function paintWater() {
    if (!W) return;
    var host = document.getElementById('card-wq');
    if (!host) return;
    var card = document.getElementById('card-wsites');
    if (!card) { card = el('div', 'rg-card'); card.id = 'card-wsites'; host.parentNode.insertBefore(card, host.nextSibling); }
    card.replaceChildren();
    var t0 = W.tests[0].date, t1 = W.tests[1].date, n = W.sites.length;
    var head = el('div', 'rg-row'); head.append(el('h3', null, 'Irrigation water by site'), el('span', 'rg-note', W.lab + ' · ' + dm(t0) + ' and ' + dm(t1) + ' ' + t1.slice(0, 4) + ' · ' + n + ' sample sites'));
    card.appendChild(head);

    var top = el('div', 'rg-wq-top');
    var ec = range('EC'), sar = range('SAR'), gy = range('Gypsum');
    var naUp = W.sites.filter(function (s) { return s.v.Na[1] > s.v.Na[0]; }).length;
    var dam = W.sites.filter(function (s) { return /dam/i.test(s.name); })[0] || W.sites[0];
    [
      { l: 'EC, ' + dm(t1), v: fmt(ec.lo.x, 'EC') + ' to ' + fmt(ec.hi.x, 'EC') + ' dS/m', s: 'highest ' + ec.hi.n + ' · lowest ' + ec.lo.n },
      { l: 'SAR, ' + dm(t1), v: fmt(sar.lo.x, 'SAR') + ' to ' + fmt(sar.hi.x, 'SAR'), s: 'highest ' + sar.hi.n + ' · lowest ' + sar.lo.n },
      { l: 'Sodium since ' + dm(t0), v: 'up at ' + naUp + ' of ' + n + ' sites', s: dam.name + ' ' + fmt(dam.v.Na[0], 'Na') + ' to ' + fmt(dam.v.Na[1], 'Na') + ' ppm' },
      { l: 'Gypsum requirement, ' + dm(t1), v: fmt(gy.lo.x, 'Gypsum') + ' to ' + fmt(gy.hi.x, 'Gypsum') + ' kg/ML', s: 'lab figure · highest ' + gy.hi.n }
    ].forEach(function (t) { var st = el('div', 'st'); st.append(el('div', 'l', t.l), el('div', 'v', t.v), el('div', 's', t.s)); top.appendChild(st); });
    card.appendChild(top);

    var btns = el('div', 'ws-btns'); btns.setAttribute('role', 'group'); btns.setAttribute('aria-label', 'Sample site');
    [{ name: 'all', txt: 'All sites' }].concat(W.sites.map(function (s) { return { name: s.name, txt: s.name }; })).forEach(function (b) {
      var bt = el('button', null, b.txt); bt.type = 'button'; bt.setAttribute('aria-pressed', String(pick === b.name));
      bt.addEventListener('click', function () { pick = b.name; paintWater(); });
      btns.appendChild(bt);
    });
    card.appendChild(btns);

    var wrap = el('div', 'ws-scroll'), tb = el('table'), thead = el('thead'), tr = el('tr'), body = el('tbody');
    if (pick === 'all') {
      tr.appendChild(el('th', null, 'Site, ' + dm(t1)));
      KEY.forEach(function (k) { var p = label(k); tr.appendChild(el('th', 'n', (k === 'Gypsum' ? 'Gypsum' : k === 'adjSAR' ? 'adj SAR' : k) + (p.unit && p.unit !== 'ppm' ? ' ' + p.unit : ''))); });
      tr.appendChild(el('th', null, 'Infiltration'));
      W.sites.forEach(function (s) {
        var r = el('tr'); r.appendChild(el('td', null, s.name));
        KEY.forEach(function (k) { var td = el('td', 'n', fmt(s.v[k][1], k)); td.appendChild(delta(s.v[k][0], s.v[k][1])); r.appendChild(td); });
        var td = el('td'); td.appendChild(chip(infil(s.v.SAR[1], s.v.EC[1]))); r.appendChild(td);
        body.appendChild(r);
      });
    } else {
      var s = W.sites.filter(function (x) { return x.name === pick; })[0];
      [s.name, dm(t0), dm(t1), 'Change'].forEach(function (h, i) { tr.appendChild(el('th', i > 0 ? 'n' : null, h)); });
      W.params.forEach(function (p) {
        var a = s.v[p.k][0], b = s.v[p.k][1], r = el('tr'), name = el('td', 'p', p.label + (p.unit ? ' ' + p.unit : '')), rt = rate(p.k, s.v, 1);
        if (rt) { var nt = el('div', 'rg-note'); if (rt[1] !== 'pH' && rt[1] !== 'boron') nt.append(rt[1] + ' '); nt.appendChild(chip(rt[0])); name.appendChild(nt); }
        var ch = el('td', 'n'), dlt = b - a;
        ch.textContent = Math.abs(dlt) < 1e-9 ? '=' : (dlt > 0 ? '+' : '−') + fmt(Math.abs(dlt), p.k);
        ch.className = 'n ' + (Math.abs(dlt) < 1e-9 ? 'fl' : '');
        r.append(name, el('td', 'n', fmt(a, p.k)), el('td', 'n', fmt(b, p.k)), ch);
        body.appendChild(r);
      });
      var v = s.v, rsc = v.HCO3[1] / 61.02 + v.CO3[1] / 30.0 - v.Ca[1] / 20.04 - v.Mg[1] / 12.15;
      var rr = el('tr'), rn = el('td', 'p', 'RSC meq/L'), rnn = el('div', 'rg-note', 'residual sodium carbonate, worked out from the lab figures ');
      var rsc0 = v.HCO3[0] / 61.02 + v.CO3[0] / 30.0 - v.Ca[0] / 20.04 - v.Mg[0] / 12.15;
      rnn.appendChild(chip(rsc < 1.25 ? 'safe' : rsc <= 2.5 ? 'marginal' : 'unsuitable')); rn.appendChild(rnn);
      rr.append(rn, el('td', 'n', rsc0.toFixed(2)), el('td', 'n', rsc.toFixed(2)), el('td', 'n', (rsc - rsc0 >= 0 ? '+' : '−') + Math.abs(rsc - rsc0).toFixed(2)));
      body.appendChild(rr);
    }
    thead.appendChild(tr); tb.append(thead, body); wrap.appendChild(tb); card.appendChild(wrap);
    card.appendChild(el('p', 'rg-note', (pick === 'all' ? '▲ ▼ = change since ' + dm(t0) + '. Tap a site for all ' + W.params.length + ' results. ' : '') +
      'Ratings are for ' + dm(t1) + ' and use the same FAO-29 limits as the dam table above. ' + W.note + ' Lab refs ' + W.tests.map(function (t) { return t.ref; }).join(' and ') + '.'));
  }

  D.onData(function () { paintSources(); paintWater(); });
  fetch('water_sites.json?v=' + Date.now()).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j && j.sites && j.tests && j.tests.length === 2) { W = j; paintWater(); } })
    .catch(function () {});
})();
