// VIP store — catalogue + multi-item Stripe Checkout.
// Routed from src/index.js for /api/vipstore/*. Uses the existing
// STRIPE_SECRET_KEY secret and SITE_ORIGIN var — no new config needed.

import shop from './shop.json';

const STRIPE_KEY_NAME = 'STRIPE_SECRET_KEY';
const LOCALES = ['en', 'de', 'pt'];

const activeProducts = () => shop.products.filter((p) => p.active !== false);

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
  const products = activeProducts();
  const used = new Set(products.map((p) => p.category));
  return {
    currency: shop.currency,
    open: shop.open,
    maxItemsPerOrder: shop.maxItemsPerOrder,
    categories: shop.categories.filter((c) => used.has(c.id)),
    products: products.map((p) => ({
      id: p.id,
      category: p.category,
      name: p.name,
      description: p.description,
      price: p.price,
      images: p.images || [],
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

  const lang = LOCALES.includes(body?.lang) ? body.lang : 'en';
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length || items.length > 20) return json({ error: 'empty_cart' }, 400);

  const deliveryKey = body.delivery;
  const deliveryOpt = Object.prototype.hasOwnProperty.call(shop.delivery, deliveryKey)
    ? shop.delivery[deliveryKey]
    : null;
  if (!deliveryOpt) return json({ error: 'bad_delivery' }, 400);

  // Validate and merge lines (same product + size → one line)
  const lines = new Map();
  for (const it of items) {
    const product = activeProducts().find((p) => p.id === it?.productId);
    if (!product) return json({ error: 'unknown_product', productId: it?.productId }, 400);
    if (!Object.prototype.hasOwnProperty.call(product.sizes, it.size)) {
      return json({ error: 'unknown_size', productId: product.id }, 400);
    }
    const qty = Number.parseInt(it.quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) return json({ error: 'bad_quantity' }, 400);
    const key = `${product.id}:${it.size}`;
    const prev = lines.get(key);
    lines.set(key, { product, size: it.size, qty: (prev?.qty || 0) + qty });
  }

  let total = 0;
  for (const l of lines.values()) {
    if (l.product.sizes[l.size] < l.qty) {
      return json({ error: 'out_of_stock', productId: l.product.id, size: l.size }, 409);
    }
    total += l.qty;
  }
  if (total > shop.maxItemsPerOrder) return json({ error: 'too_many_items' }, 400);

  const key = env[STRIPE_KEY_NAME];
  if (!key) return json({ error: 'stripe_not_configured' }, 500);

  // Compact order summary for metadata (Stripe limit: 500 chars per value)
  const summary = [...lines.values()].map((l) => `${l.product.id}:${l.size}:${l.qty}`).join(',');
  const meta = { type: 'vipstore', items: summary.slice(0, 500), delivery: deliveryKey };

  const params = {
    mode: 'payment',
    locale: lang,
    allow_promotion_codes: 'true',
    'phone_number_collection[enabled]': 'true',
    success_url: `${origin}/vipstore/?ordered=1&lang=${lang}`,
    cancel_url: `${origin}/vipstore/?cart=1&lang=${lang}`,
    ...flat('metadata', meta),
    ...flat('payment_intent_data[metadata]', meta),
  };

  [...lines.values()].forEach((l, i) => {
    const p = `line_items[${i}]`;
    params[`${p}[quantity]`] = String(l.qty);
    params[`${p}[price_data][currency]`] = shop.currency;
    params[`${p}[price_data][unit_amount]`] = String(l.product.price);
    params[`${p}[price_data][product_data][name]`] = `${l.product.name[lang]} — ${l.size}`;
    params[`${p}[price_data][product_data][metadata][product]`] = l.product.id;
    params[`${p}[price_data][product_data][metadata][size]`] = l.size;
  });

  if (deliveryKey === 'pickup') {
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
    console.log('Stripe error', data?.error?.message);
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
