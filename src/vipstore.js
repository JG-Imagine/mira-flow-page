// VIP store — catalogue + Stripe Checkout for apparel.
// Routed from src/index.js for /api/vipstore/*. Uses the existing
// STRIPE_SECRET_KEY secret and SITE_ORIGIN var — no new config needed.

import shop from './shop.json';

const STRIPE_KEY_NAME = 'STRIPE_SECRET_KEY';

const LOCALES = ['en', 'de', 'pt'];

export async function handleVipStore(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/api/vipstore/catalog' && request.method === 'GET') {
    return json(publicCatalog(), 200, { 'Cache-Control': 'no-store' });
  }

  if (url.pathname === '/api/vipstore/checkout' && request.method === 'POST') {
    return createCheckout(request, env, env.SITE_ORIGIN || url.origin);
  }

  return null; // not ours — let index.js continue routing
}

function publicCatalog() {
  return {
    currency: shop.currency,
    open: shop.open,
    products: shop.products.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      images: p.images,
      maxPerOrder: p.maxPerOrder,
      // Expose availability, not exact stock counts above 3
      sizes: Object.fromEntries(
        Object.entries(p.sizes).map(([size, n]) => [size, n <= 0 ? 0 : n <= 3 ? n : 'ok'])
      ),
    })),
    delivery: Object.fromEntries(
      Object.entries(shop.delivery).map(([k, d]) => [k, { price: d.price, label: d.label }])
    ),
  };
}

async function createCheckout(request, env, origin) {
  if (!shop.open) return json({ error: 'store_closed' }, 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  const { productId, size, quantity, delivery } = body || {};
  const lang = LOCALES.includes(body?.lang) ? body.lang : 'en';

  const product = shop.products.find((p) => p.id === productId);
  if (!product) return json({ error: 'unknown_product' }, 400);

  if (!Object.prototype.hasOwnProperty.call(product.sizes, size)) {
    return json({ error: 'unknown_size' }, 400);
  }

  const qty = Number.parseInt(quantity, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > product.maxPerOrder) {
    return json({ error: 'bad_quantity' }, 400);
  }
  if (product.sizes[size] < qty) return json({ error: 'out_of_stock' }, 409);

  const deliveryOpt = shop.delivery[delivery];
  if (!deliveryOpt) return json({ error: 'bad_delivery' }, 400);

  const key = env[STRIPE_KEY_NAME];
  if (!key) return json({ error: 'stripe_not_configured' }, 500);

  const meta = { type: 'vipstore', product: product.id, size, quantity: String(qty), delivery };

  const params = {
    mode: 'payment',
    locale: lang,
    allow_promotion_codes: 'true',
    'phone_number_collection[enabled]': 'true',
    success_url: `${origin}/vipstore/?ordered=1&lang=${lang}`,
    cancel_url: `${origin}/vipstore/?lang=${lang}`,
    'line_items[0][quantity]': String(qty),
    'line_items[0][price_data][currency]': shop.currency,
    'line_items[0][price_data][unit_amount]': String(product.price),
    'line_items[0][price_data][product_data][name]': `${product.name[lang]} — ${size}`,
    'line_items[0][price_data][product_data][description]': deliveryOpt.label[lang],
    ...flat('metadata', meta),
    ...flat('payment_intent_data[metadata]', meta),
  };

  if (delivery === 'pickup') {
    Object.assign(params, {
      'custom_fields[0][key]': 'pickup',
      'custom_fields[0][type]': 'dropdown',
      'custom_fields[0][label][type]': 'custom',
      'custom_fields[0][label][custom]': PICKUP_LABEL[lang],
      'custom_fields[0][dropdown][options][0][label]': PICKUP_OPTS[lang][0],
      'custom_fields[0][dropdown][options][0][value]': 'retreat',
      'custom_fields[0][dropdown][options][1][label]': PICKUP_OPTS[lang][1],
      'custom_fields[0][dropdown][options][1][value]': 'milfontes',
      'custom_text[submit][message]': PICKUP_NOTE[lang],
    });
  } else {
    deliveryOpt.countries.forEach((c, i) => {
      params[`shipping_address_collection[allowed_countries][${i}]`] = c;
    });
    Object.assign(params, {
      'shipping_options[0][shipping_rate_data][type]': 'fixed_amount',
      'shipping_options[0][shipping_rate_data][fixed_amount][amount]': String(deliveryOpt.price),
      'shipping_options[0][shipping_rate_data][fixed_amount][currency]': shop.currency,
      'shipping_options[0][shipping_rate_data][display_name]': deliveryOpt.label[lang],
    });
  }

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error('Stripe error', data?.error?.message);
    return json({ error: 'stripe_error' }, 502);
  }
  return json({ url: data.url });
}

const PICKUP_LABEL = {
  en: 'Where will you collect it?',
  de: 'Wo holst du es ab?',
  pt: 'Onde vais levantar?',
};
const PICKUP_OPTS = {
  en: ['At my Mira Flow retreat', 'Arrange pickup in Vila Nova de Milfontes'],
  de: ['Bei meinem Mira Flow Retreat', 'Abholung in Vila Nova de Milfontes vereinbaren'],
  pt: ['No meu retiro Mira Flow', 'Combinar levantamento em Vila Nova de Milfontes'],
};
const PICKUP_NOTE = {
  en: "We'll contact you by email or phone to arrange pickup.",
  de: 'Wir melden uns per E-Mail oder Telefon, um die Abholung zu vereinbaren.',
  pt: 'Entraremos em contacto por email ou telefone para combinar o levantamento.',
};

function flat(prefix, obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [`${prefix}[${k}]`, v]));
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
