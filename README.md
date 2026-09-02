# Mira Flow — site + waitlist

Cloudflare Worker with static assets. The site and the waitlist API
share one domain, so there is no CORS and no API key in the browser.

## Structure

```
wrangler.jsonc        Worker config: entry point + assets directory
src/index.js          Worker. Handles /api/waitlist, passes the rest to assets
public/               Everything served as a static file
  index.html
  milfontes-hero.mp4  <-- YOU MUST ADD THIS. Not included in this package.
```

## Before your first deploy

1. **Add the hero video.** Copy `milfontes-hero.mp4` into `public/`.
   Without it the hero video breaks.

2. **Check the Worker name.** Open `wrangler.jsonc` and set `name` to match
   your existing Worker in the Cloudflare dashboard, exactly. A mismatch
   creates a second Worker instead of updating yours, and your custom
   domain stays pointed at the old one.

3. **Delete the old `functions/` folder** from the repo. It was never
   compiled and is currently served as a public file.

4. **Set the secrets on the Worker.** Dashboard → your Worker → Settings →
   Variables and Secrets:
   - `BREVO_API_KEY` — your rotated Brevo key (Secret)
   - `BREVO_LIST_ID` — `2`

   Or from the command line:
   ```
   npx wrangler secret put BREVO_API_KEY
   npx wrangler secret put BREVO_LIST_ID
   ```

   Secrets are NOT in `wrangler.jsonc` on purpose. Never commit them.

## Deploying

Git-connected: commit and push. Cloudflare builds automatically.

```
git add -A
git commit -m "Move site to Workers with assets; waitlist API server-side"
git push
```

Or directly:
```
npx wrangler deploy
```

## Verifying

1. Open `https://mira-flow.ch/api/waitlist` in a browser.
   Expect `{"error":"method_not_allowed"}`, status 405.
   A 404 means the Worker isn't handling the route.

2. Open `https://mira-flow.ch` — site loads, hero video plays.

3. Submit the form from a phone on mobile data with a fresh email.
   Check the contact appears in Brevo.

4. If anything fails: dashboard → your Worker → Logs, then submit again
   while watching. The log tells you exactly which step broke.

## Rollback

Dashboard → your Worker → Deployments → pick the previous version →
Rollback. Restores the last working state immediately.

## One thing to leave alone

Do not re-enable Brevo's Authorized IPs / IP blocking. The calls now come
from Cloudflare's edge network, whose addresses rotate constantly and
cannot be listed. The protection now is that the key is a server-side
secret, which is the correct control for this setup.
