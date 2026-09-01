// Mira Flow — waitlist endpoint
// Cloudflare Pages Function. Live at https://mira-flow.ch/api/waitlist
//
// The Brevo API key is read from Cloudflare environment variables and is
// never sent to the browser. Set these in:
//   Cloudflare dashboard → Pages project → Settings → Variables and Secrets
//     BREVO_API_KEY   (type: Secret)  — your NEW rotated key
//     BREVO_LIST_ID   (type: Text)    — 2

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    // Honeypot: the hidden field is invisible to humans. If it's filled,
    // it's a bot. Return success so it doesn't retry.
    if (body.company) {
      return json({ ok: true }, 200);
    }

    const email = String(body.email || '').trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
      return json({ error: 'invalid_email' }, 400);
    }

    if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID) {
      console.log('Missing BREVO_API_KEY or BREVO_LIST_ID environment variable');
      return json({ error: 'not_configured' }, 500);
    }

    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': env.BREVO_API_KEY
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

    // Already subscribed — success from the visitor's point of view
    if (res.status === 400 && detail.toLowerCase().includes('already')) {
      return json({ ok: true, existing: true }, 200);
    }

    // Anything else is a real failure. Logged so you can see it in
    // Cloudflare → your Pages project → Functions → Real-time logs
    console.log('Brevo rejected:', res.status, detail);
    return json({ error: 'upstream' }, 502);

  } catch (err) {
    console.log('waitlist error:', err && err.message);
    return json({ error: 'server_error' }, 500);
  }
}

// Reject anything that isn't a POST
export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }
  return onRequestPost(context);
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { 'content-type': 'application/json' }
  });
}
