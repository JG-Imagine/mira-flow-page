/**
 * Shared booking module — used by weekend.html and book-week.html.
 *
 * Holds no prices and no dates. Everything comes from /api/editions,
 * which is priced from public/editions.json by the same code that
 * prices the Stripe charge.
 *
 * The page supplies BOOKING_CONFIG before loading this file:
 *   product       'weekend' | 'week'
 *   tierDesc      { tierId: i18nKey }   description under each tier
 *   optDesc       { optionId: i18nKey } description under each option
 *   t(key)        the page's translator
 *   lang()        current language code
 *   money(n)      the page's currency formatter
 *
 * Expected element ids: dates, tiers, opts, paymode, sum-list, sum-total,
 * agree, consent, pay-btn, pay-err. base-price is optional.
 */

let FEED = null;      // { product, currency, deposit, editions: [...] }
let edition = null;   // selected edition, prices already resolved
let payMode = 'full';

const B = () => window.BOOKING_CONFIG;
const el = id => document.getElementById(id);

async function loadFeed() {
  try {
    const res = await fetch('/api/editions?product=' + encodeURIComponent(B().product));
    if (!res.ok) throw new Error('bad status');
    FEED = await res.json();
    if (!FEED.editions || !FEED.editions.length) throw new Error('empty');
    renderAll();
  } catch {
    // No invented fallback prices: if the feed is down, say so rather than
    // showing a number that might not be what the buyer would be charged.
    el('dates').innerHTML = `<p class="opt-sub">${B().t('_loadfail')}</p>`;
    el('pay-btn').disabled = true;
  }
}

function renderDates() {
  const { t, lang } = B();
  const L = lang();
  el('dates').innerHTML = FEED.editions.map(x => {
    const gone = x.left === 0;
    const few = !gone && x.left <= 4;
    const label = gone ? t('_gone') : `${x.left} ${few ? t('_few') : t('_open')}`;
    const sel = edition && edition.id === x.id;
    return `<label class="dt ${gone ? 'gone' : ''} ${sel ? 'sel' : ''}">
      <input type="radio" name="edition" value="${x.id}" ${gone ? 'disabled' : ''}
             ${sel ? 'checked' : ''} onchange="pickDate('${x.id}')">
      <span><span class="dt-d">${x.label[L] || x.label.pt}</span>
      <span class="dt-m">${x.note[L] || x.note.pt}</span></span>
      <span class="dt-s ${gone ? 'gone' : (few ? 'few' : 'open')}">${label}</span>
    </label>`;
  }).join('');
}

function renderChoices() {
  const { t, lang, money, tierDesc, optDesc } = B();
  const L = lang();
  const tiers = el('tiers'), opts = el('opts'), pay = el('paymode');

  if (!edition) {
    // Prices vary by edition, so there is nothing honest to show yet.
    tiers.innerHTML = `<p class="opt-sub">${t('_pickfirst')}</p>`;
    opts.innerHTML = '';
    if (pay) pay.innerHTML = '';
    if (el('base-price')) el('base-price').innerHTML = '—';
    return;
  }

  const keep = new Set([...document.querySelectorAll('[data-opt]:checked')].map(c => c.dataset.opt));
  const tierIds = Object.keys(edition.tiers);
  const current = document.querySelector('input[name="tier"]:checked');
  // An edition may not offer the previously selected tier — fall back to the first.
  const tierNow = current && tierIds.includes(current.value) ? current.value : tierIds[0];

  tiers.innerHTML = tierIds.map(id => {
    const tr = edition.tiers[id];
    const desc = tierDesc && tierDesc[id] ? t(tierDesc[id]) : '';
    return `<label class="opt">
      <input type="radio" name="tier" value="${id}" ${tierNow === id ? 'checked' : ''} onchange="recalc()">
      <span><span class="opt-n">${tr.name[L] || tr.name.pt}</span>
      ${desc ? `<span class="opt-d">${desc}</span>` : ''}</span>
      <span class="opt-p ${tr.price ? '' : 'free'}">${tr.price ? (edition.base > 0 ? '+ ' : '') + money(tr.price) : '—'}</span>
    </label>`;
  }).join('');

  opts.innerHTML = edition.options.map(o => `<label class="opt">
      <input type="checkbox" data-opt="${o.id}" ${keep.has(o.id) ? 'checked' : ''} onchange="recalc()">
      <span><span class="opt-n">${o.name[L] || o.name.pt}</span>
      ${optDesc && optDesc[o.id] ? `<span class="opt-d">${t(optDesc[o.id])}</span>` : ''}</span>
      <span class="opt-p">+ ${money(o.price)}</span>
    </label>`).join('');

  if (pay) {
    pay.innerHTML = edition.deposit ? `
      <label class="opt">
        <input type="radio" name="paymode" value="full" ${payMode === 'full' ? 'checked' : ''} onchange="setPayMode('full')">
        <span><span class="opt-n">${t('_payfull')}</span>
        <span class="opt-d">${t('_payfulld')}</span></span>
        <span class="opt-p" id="pm-full"></span>
      </label>
      <label class="opt">
        <input type="radio" name="paymode" value="deposit" ${payMode === 'deposit' ? 'checked' : ''} onchange="setPayMode('deposit')">
        <span><span class="opt-n">${t('_paydep')}</span>
        <span class="opt-d" id="pm-dep-d"></span></span>
        <span class="opt-p" id="pm-dep"></span>
      </label>` : '';
  }

  if (el('base-price')) el('base-price').innerHTML = money(edition.base);
}

function renderAll() { renderDates(); renderChoices(); recalc(); }

window.pickDate = function (id) {
  const e = FEED.editions.find(x => x.id === id);
  if (!e || e.left === 0) return;
  edition = e;
  renderAll();
};

window.setPayMode = function (mode) { payMode = mode; recalc(); };

function selection() {
  const tierEl = document.querySelector('input[name="tier"]:checked');
  return {
    date: edition ? edition.id : null,
    tier: tierEl ? tierEl.value : null,
    options: [...document.querySelectorAll('[data-opt]')].filter(c => c.checked).map(c => c.dataset.opt)
  };
}

/** Mirrors the server calculation in src/checkout.js. */
function totals() {
  const { tier, options } = selection();
  const rows = [];
  let total = edition.base;
  if (edition.base > 0) rows.push([B().t('_base'), edition.base]);

  const tr = edition.tiers[tier];
  if (tr) {
    total += tr.price;
    if (tr.price > 0) rows.push([tr.name[B().lang()] || tr.name.pt, tr.price]);
  }
  edition.options.filter(o => options.includes(o.id)).forEach(o => {
    total += o.price;
    rows.push([o.name[B().lang()] || o.name.pt, o.price]);
  });
  return { rows, total };
}

window.recalc = function () {
  const { t, money } = B();
  const list = el('sum-list'), btn = el('pay-btn'), err = el('pay-err');

  if (!edition) {
    list.innerHTML = '';
    el('sum-total').innerHTML = '—';
    btn.disabled = true;
    return;
  }

  const { rows, total } = totals();
  let html = rows.map(([label, amount], i) =>
    `<li><span>${label}</span><span>${i === 0 && edition.base > 0 ? '' : '+ '}${money(amount)}</span></li>`).join('');

  const dep = edition.deposit;
  const taking = !!dep && payMode === 'deposit' && dep.amount < total;

  if (dep) {
    if (el('pm-full')) el('pm-full').innerHTML = money(total);
    if (el('pm-dep')) el('pm-dep').innerHTML = money(dep.amount);
    if (el('pm-dep-d')) {
      el('pm-dep-d').innerHTML = t('_paydepd')
        .replace('{balance}', money(Math.max(total - dep.amount, 0)))
        .replace('{days}', dep.balanceDueDays);
    }
  }

  if (taking) {
    html += `<li><span>${t('_subtotal')}</span><span>${money(total)}</span></li>`;
    html += `<li><span>${t('_balancelater')}</span><span>${money(total - dep.amount)}</span></li>`;
  }

  list.innerHTML = html;
  el('sum-total').innerHTML = money(taking ? dep.amount : total);
  el('sum-vat').innerHTML = taking ? t('_vatdep') : t('sm-vat');

  btn.disabled = !el('agree').checked;
  if (err.textContent === t('_pick')) err.style.display = 'none';
};

window.checkout = async function () {
  const { t } = B();
  const btn = el('pay-btn'), err = el('pay-err');
  const sel = selection();
  if (!sel.date || !sel.tier) return;

  err.style.display = 'none';
  btn.disabled = true;
  btn.textContent = '\u2026';
  try {
    // Only choice keys go over the wire. Never prices.
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product: B().product,
        date: sel.date,
        tier: sel.tier,
        options: sel.options,
        payMode,
        lang: B().lang(),
        imageConsent: el('consent') ? el('consent').checked : false
      })
    });
    const data = await res.json();
    if (res.ok && data.url) { window.location = data.url; return; }
    // Someone took the last place, or the edition stopped offering this tier,
    // while the page sat open. Reload the feed so the buyer sees the truth.
    if (res.status === 409 || data.error === 'tier_unavailable') {
      await loadFeed();
      throw new Error(res.status === 409 ? 'sold_out' : 'tier');
    }
    throw new Error(data.error || 'checkout_failed');
  } catch (e) {
    btn.disabled = false;
    btn.innerHTML = t('sm-btn');
    err.textContent = e.message === 'sold_out' ? t('_soldout')
                    : e.message === 'tier' ? t('_tiergone') : t('_err');
    err.style.display = 'block';
  }
};

window.refreshBooking = function () { if (FEED) renderAll(); };
window.addEventListener('DOMContentLoaded', loadFeed);
