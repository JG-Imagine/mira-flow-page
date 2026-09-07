/**
 * Looks up one Checkout Session so the confirmation page can name what was
 * bought instead of showing a generic thank-you.
 *
 * Returns a deliberately narrow set of fields. The session id sits in a URL
 * that may be shared or logged, so nothing goes back that would matter if a
 * stranger held it: no address, no card, no phone, no line-item breakdown.
 *
 * Wire into src/index.js:
 *   if (url.pathname === '/api/session') return handleSession(request, env);
 */

import { loadEditions, resolve } from './editions.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    // Never cache: a booking's state changes when a Multibanco payment clears.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });

export async function handleSession(request, env) {
  const id = new URL(request.url).searchParams.get('id') || '';

  // Cheap shape check before spending a Stripe call on obvious junk.
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) return json({ error: 'bad_id' }, 400);

  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
  });

  if (!res.ok) {
    console.error('session_lookup_failed', res.status, await res.text());
    return json({ error: 'not_found' }, 404);
  }

  const s = await res.json();
  const md = s.metadata || {};

  // Three outcomes the page has to tell apart:
  //   paid     card cleared, the place is theirs
  //   pending  Multibanco or MB Way reference issued, money not in yet
  //   open     they landed here without completing anything
  let state = 'open';
  if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') state = 'paid';
  else if (s.status === 'complete' && s.payment_status === 'unpaid') state = 'pending';

  // Edition label comes from our own file, not from Stripe, so it is
  // translated properly rather than echoing whatever language they paid in.
  let edition = null;
  if (md.product && md.date) {
    const ed = resolve(loadEditions(), md.product, md.date);
    if (ed) edition = { id: ed.id, label: ed.label, tiers: ed.tiers };
  }

  const full = Number(md.full_total || 0);
  const paidNow = (s.amount_total || 0) / 100;

  return json({
    state,
    product: md.product || null,
    edition,
    tier: md.tier || null,
    options: md.options && md.options !== 'none' ? md.options.split(',') : [],
    currency: (s.currency || 'eur').toUpperCase(),
    paidNow,
    fullTotal: full || paidNow,
    payMode: md.pay_mode || 'full',
    balanceDue: Number(md.balance_due || 0),
    balanceDueDate: md.balance_due_date || null,
    lang: md.lang || null,
    firstName: firstNameOf(s.customer_details && s.customer_details.name)
  });
}

/** First name only — enough to greet someone, not enough to identify them. */
function firstNameOf(name) {
  if (!name || typeof name !== 'string') return null;
  const first = name.trim().split(/\s+/)[0];
  return first && first.length <= 40 ? first : null;
}
