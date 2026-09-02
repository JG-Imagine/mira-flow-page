// Mira Flow — Worker entry point
//
// Static files in /public are served automatically by Cloudflare.
// This Worker only runs for paths that don't match a static file,
// which in practice means /api/waitlist.
//
// Because the site and the API share one domain, there is no CORS
// here and no API key ever reaches the browser.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/waitlist') {
      return handleWaitlist(request, env);
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

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
      return json({ error: 'invalid_email' }, 400);
    }

    if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID) {
      console.log('Missing BREVO_API_KEY or BREVO_LIST_ID');
      return json({ error: 'not_configured' }, 500);
    }

    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': env.BREVO_API_KEY.trim()
      },
      body: JSON.stringify({
        email: email,
        listIds: [Number(env.BREVO_LIST_ID)],
        updateEnabled: true,
        attributes: { SOURCE: 'mira-flow-website' }
      })
    });

    if (res.ok || res.status === 204) {
      return json({ ok: true }, 200);
    }

    const detail = await res.text();

    // Already on the list — a success from the visitor's point of view.
    if (res.status === 400 && detail.toLowerCase().includes('already')) {
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
