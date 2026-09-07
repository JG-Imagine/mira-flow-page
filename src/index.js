// Mira Flow — Worker entry point
//
// Static files in /public are served by env.ASSETS. This Worker handles
// the API routes below and hands everything else back to the assets binding.
//
// Because the site and the API share one domain, there is no CORS
// here and no API key ever reaches the browser.
//
// Secrets (wrangler secret put — never in wrangler.jsonc):
//   BREVO_API_KEY, STRIPE_SECRET_KEY
// Plain vars (declare in wrangler.jsonc or they are wiped on deploy):
//   BREVO_LIST_ID, BREVO_DOI_TEMPLATE_ID, SITE_ORIGIN

import { handleCheckout } from './checkout.js';
import { loadEditions, publicView } from './editions.js';

const LANGS = ['en', 'de', 'pt'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/waitlist') {
      return handleWaitlist(request, env);
    }

    // The page renders dates, rooms and extras from this, so the prices shown
    // and the prices charged come from one file: public/editions.json.
    if (url.pathname === '/api/editions') {
      try {
        const config = await loadEditions(request, env);
        const view = publicView(config, url.searchParams.get('product') || 'weekend');
        if (!view) return json({ error: 'unknown_product' }, 404);
        return new Response(JSON.stringify(view), {
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' }
        });
      } catch (err) {
        console.log('editions error:', err && err.message);
        return json({ error: 'editions_unavailable' }, 500);
      }
    }

    if (url.pathname === '/api/checkout') {
      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed' }, 405);
      }
      return handleCheckout(request, env);
    }

    // Without this, a typo'd endpoint gets served the 404 asset page —
    // an HTML body where the browser expected JSON, which reads as a
    // broken site rather than a bad path.
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'not_found' }, 404);
    }

    // Anything else: hand back to static assets.
    return env.ASSETS.fetch(request);
  }
};

async function handleWaitlist(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  try {
    const body = await request.json();

    // Honeypot: the field is hidden from humans. Filled in = bot.
    // Return success so it doesn't retry.
    if (body.company) {
      return json({ ok: true }, 200);
    }

    const email = String(body.email || '').trim().toLowerCase();
    const lang  = LANGS.includes(body.lang) ? body.lang : 'en';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
      return json({ error: 'invalid_email' }, 400);
    }

    if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID || !env.BREVO_DOI_TEMPLATE_ID) {
      console.log('Missing BREVO_API_KEY, BREVO_LIST_ID or BREVO_DOI_TEMPLATE_ID');
      return json({ error: 'not_configured' }, 500);
    }

    const origin = env.SITE_ORIGIN || 'https://mira-flow.ch';

    // Double opt-in: Brevo sends the confirmation email and only adds the
    // contact to the list after they click. Nothing appears in All Contacts
    // until then.
    const res = await fetch('https://api.brevo.com/v3/contacts/doubleOptinConfirmation', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': env.BREVO_API_KEY.trim()
      },
      body: JSON.stringify({
        email: email,
        includeListIds: [Number(env.BREVO_LIST_ID)],
        templateId: Number(env.BREVO_DOI_TEMPLATE_ID),
        redirectionUrl: `${origin}/confirmed.html?lang=${lang}`,
        attributes: {
          SOURCE: 'mira-flow-website',
          LANG: lang
        }
      })
    });

    if (res.ok || res.status === 201 || res.status === 204) {
      return json({ ok: true }, 200);
    }

    const detail = await res.text();

    // Already subscribed and confirmed — success from the visitor's view.
    if (res.status === 400 &&
        (detail.toLowerCase().includes('already') ||
         detail.toLowerCase().includes('duplicate'))) {
      return json({ ok: true, existing: true }, 200);
    }

    console.log('Brevo rejected:', res.status, detail);
    return json({ error: 'upstream' }, 502);

  } catch (err) {
    console.log('waitlist error:', err && err.message);
    return json({ error: 'server_error' }, 500);
  }
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { 'content-type': 'application/json' }
  });
}
