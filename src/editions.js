/**
 * Loads public/editions.json and resolves one edition's prices.
 *
 * The same resolve() runs on the server for Stripe and, via /api/editions,
 * feeds the booking pages. The price a buyer sees and the price they are
 * charged come from one calculation over one file, so they cannot disagree.
 */

let cache = null; // per-isolate; cleared on deploy

export async function loadEditions(request, env) {
  if (cache) return cache;
  const res = await env.ASSETS.fetch(new Request(new URL('/editions.json', request.url)));
  if (!res.ok) throw new Error('editions.json missing');
  cache = await res.json();
  return cache;
}

export function getProduct(config, name) {
  return (config.products && config.products[name]) || null;
}

/**
 * Merge an edition's overrides over the product defaults.
 * An edition lists only what differs, so adding a date stays a small edit.
 */
export function resolve(config, productName, editionId) {
  const product = getProduct(config, productName);
  if (!product) return null;
  const edition = product.editions.find(e => e.id === editionId);
  if (!edition) return null;

  const over = edition.prices || {};
  const overTiers = over.tiers || {};
  const overOpts = over.options || {};

  // An edition may allow only some tiers — this is what stops a Classic
  // place being sold into a Full Experience week.
  const allowed = Array.isArray(edition.tiers)
    ? edition.tiers
    : Object.keys(product.defaults.tiers);

  const tiers = {};
  for (const id of allowed) {
    const def = product.defaults.tiers[id];
    if (!def) continue;
    tiers[id] = {
      id,
      name: def.name,
      price: overTiers[id] !== undefined ? overTiers[id] : def.price
    };
  }

  return {
    product: productName,
    id: edition.id,
    label: edition.label,
    note: edition.note,
    left: edition.left,
    currency: product.currency,
    base: over.base !== undefined ? over.base : product.defaults.base,
    tiers,
    options: product.defaults.options.map(o => ({
      id: o.id,
      name: o.name,
      price: overOpts[o.id] !== undefined ? overOpts[o.id] : o.price
    })),
    deposit: product.defaults.deposit || null
  };
}

/** Everything a booking page needs to render and price its form. */
export function publicView(config, productName) {
  const product = getProduct(config, productName);
  if (!product) return null;
  return {
    product: productName,
    currency: product.currency,
    deposit: product.defaults.deposit || null,
    editions: product.editions.map(e => resolve(config, productName, e.id))
  };
}
