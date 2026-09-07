/**
 * Stripe Checkout for Mira Flow — weekend and week.
 *
 * Wire into src/index.js:
 *   import { handleCheckout } from './checkout.js';
 *   if (url.pathname === '/api/checkout' && request.method === 'POST') {
 *     return handleCheckout(request, env);
 *   }
 *
 * Secret:      npx wrangler secret put STRIPE_SECRET_KEY
 * Plain var:   "SITE_ORIGIN": "https://mira-flow.ch"  in wrangler.jsonc
 *
 * NO PRICES LIVE IN THIS FILE. They are all in src/editions.json.
 * The browser sends choice keys only, never amounts.
 */

import { loadEditions, resolve } from './editions.js';

const LANGS = ['pt', 'en', 'de'];

const BASE = {
  weekend: {
    name: { pt: 'Fim de semana Mira Flow', en: 'Mira Flow weekend', de: 'Mira Flow Wochenende' },
    desc: {
      pt: 'Sexta 18:00 a domingo 15:30 · programa completo e quatro refeições',
      en: 'Friday 18:00 to Sunday 15:30 · full programme and four meals',
      de: 'Freitag 18:00 bis Sonntag 15:30 · ganzes Programm und vier Mahlzeiten'
    }
  },
  week: {
    name: { pt: 'Semana Mira Flow', en: 'Mira Flow week', de: 'Mira Flow Woche' },
    desc: {
      pt: 'Domingo a domingo em Vila Nova de Milfontes',
      en: 'Sunday to Sunday in Vila Nova de Milfontes',
      de: 'Sonntag bis Sonntag in Vila Nova de Milfontes'
    }
  }
};

const DEPOSIT_NAME = {
  pt: 'Depósito de reserva', en: 'Booking deposit', de: 'Buchungsanzahlung'
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Edition ids are the start date, so the balance date falls out of them. */
function balanceDueDate(editionId, days) {
  const d = new Date(editionId + 'T00:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function handleCheckout(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }

  if (!BASE[body.product]) return json({ error: 'unknown_product' }, 400);

  const config = loadEditions();
  const ed = resolve(config, body.product, body.date);
  if (!ed) return json({ error: 'unknown_date' }, 400);
  if (ed.left <= 0) return json({ error: 'sold_out' }, 409);

  const lang = LANGS.includes(body.lang) ? body.lang : 'pt';

  // A tier the edition does not offer is a rejection, not a silent fallback:
  // selling a Classic place into a Full Experience week breaks the no-mixing rule.
  const tier = ed.tiers[body.tier];
  if (!tier) return json({ error: 'tier_unavailable' }, 400);

  const wanted = new Set(Array.isArray(body.options) ? body.options : []);
  const chosen = ed.options.filter(o => wanted.has(o.id));

  const fullTotal = ed.base + tier.price + chosen.reduce((s, o) => s + o.price, 0);

  // Deposit only when the product defines one and the buyer asked for it.
  const takingDeposit = !!ed.deposit && body.payMode === 'deposit';
  if (takingDeposit && ed.deposit.amount >= fullTotal) {
    return json({ error: 'deposit_exceeds_total' }, 400);
  }
  const balance = takingDeposit ? fullTotal - ed.deposit.amount : 0;
  const dueDate = takingDeposit ? balanceDueDate(ed.id, ed.deposit.balanceDueDays) : null;

  const form = new URLSearchParams();
  form.set('mode', 'payment');
  // Deliberately no payment_method_types: leaving it unset is what makes Stripe
  // use the methods enabled in the dashboard, so Multibanco and MB Way can be
  // switched on there without a redeploy. Do NOT add automatic_payment_methods
  // here — that is a PaymentIntent parameter and Checkout rejects the request.
  form.set('locale', lang === 'pt' ? 'pt-BR' : lang); // Stripe has no pt-PT; pt-BR is closest.
  form.set('billing_address_collection', 'required');
  form.set('phone_number_collection[enabled]', 'true');

  const origin = env.SITE_ORIGIN || new URL(request.url).origin;
  const back = body.product === 'week' ? '/book-week.html' : '/weekend.html';
  form.set('success_url', `${origin}/reserva-confirmada.html?lang=${lang}&session_id={CHECKOUT_SESSION_ID}`);
  form.set('cancel_url', `${origin}${back}?lang=${lang}#reservar`);

  let i = 0;
  const push = (name, desc, euros) => {
    if (!(euros > 0)) return; // Stripe has nothing to charge for a €0 line.
    form.set(`line_items[${i}][price_data][currency]`, ed.currency);
    form.set(`line_items[${i}][price_data][unit_amount]`, String(Math.round(euros * 100)));
    form.set(`line_items[${i}][price_data][product_data][name]`, name);
    if (desc) form.set(`line_items[${i}][price_data][product_data][description]`, desc);
    form.set(`line_items[${i}][quantity]`, '1');
    i++;
  };

  const title = `${BASE[body.product].name[lang]} · ${ed.label[lang]}`;

  if (takingDeposit) {
    // One line, so Stripe's total is unmistakably the deposit and not the trip.
    push(
      `${DEPOSIT_NAME[lang]} — ${title}`,
      `${tier.name[lang]} · ${fmt(lang, fullTotal, ed.currency)} total · ` +
      `${fmt(lang, balance, ed.currency)} due ${dueDate}`,
      ed.deposit.amount
    );
  } else {
    if (ed.base > 0) push(title, BASE[body.product].desc[lang], ed.base);
    push(ed.base > 0 ? tier.name[lang] : `${title} · ${tier.name[lang]}`, null, tier.price);
    for (const o of chosen) push(o.name[lang], null, o.price);
  }

  if (i === 0) {
    console.error('no_line_items', body.product, ed.id, tier.id);
    return json({ error: 'nothing_to_charge' }, 400);
  }

  form.set('metadata[product]', body.product);
  form.set('metadata[date]', ed.id);
  form.set('metadata[lang]', lang);
  form.set('metadata[tier]', tier.id);
  form.set('metadata[options]', chosen.map(o => o.id).join(',') || 'none');
  form.set('metadata[full_total]', String(fullTotal));
  form.set('metadata[pay_mode]', takingDeposit ? 'deposit' : 'full');
  if (takingDeposit) {
    form.set('metadata[balance_due]', String(balance));
    form.set('metadata[balance_due_date]', dueDate || '');
  }
  // Consent to use the guest's image in marketing. Recorded separately from
  // the purchase because it has to be freely given and refusable.
  form.set('metadata[image_consent]', body.imageConsent === true ? 'yes' : 'no');

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: form
  });

  if (!res.ok) {
    const detail = await res.text();
    // Always logged in full — read it with: npx wrangler tail
    console.error('stripe_error', res.status, detail);
    let message;
    try { message = JSON.parse(detail).error.message; } catch { message = undefined; }
    // Echoed to the browser only when you switch it on, so a live customer
    // never sees Stripe's internals but you can debug without a tail open.
    return json(
      env.DEBUG_ERRORS === 'true' ? { error: 'stripe_error', detail: message } : { error: 'stripe_error' },
      502
    );
  }

  const session = await res.json();
  if (!session.url) {
    console.error('stripe_no_url', JSON.stringify(session).slice(0, 400));
    return json({ error: 'stripe_no_url' }, 502);
  }
  return json({ url: session.url });
}

function fmt(lang, amount, currency) {
  try {
    return new Intl.NumberFormat(lang === 'pt' ? 'pt-PT' : lang, {
      style: 'currency', currency: currency.toUpperCase(), maximumFractionDigits: 0
    }).format(amount);
  } catch { return `${amount}`; }
}
