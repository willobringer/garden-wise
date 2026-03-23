# GardenWise API Proxy — Setup Guide

This folder contains the Cloudflare Worker that securely proxies
requests between your GardenWise app and the Anthropic API.

Your API key is stored **only** in Cloudflare's secure environment —
never in the app code where users could extract it.

---

## Method A: Dashboard (easiest — no command line needed)

1. Go to https://dash.cloudflare.com and sign up for a free account
2. Click **Workers & Pages** in the left sidebar
3. Click **Create Application** → **Create Worker**
4. Delete all the default code in the editor
5. Copy the entire contents of `worker.js` and paste it in
6. Click **Save and Deploy**
7. Note your worker URL — it will look like:
   `https://gardenwise-proxy.YOURNAME.workers.dev`

### Add your API key (required)

8. Go to your Worker → **Settings** → **Variables and Secrets**
9. Click **Add variable** → choose **Secret**
10. Name: `ANTHROPIC_API_KEY`
11. Value: your Anthropic key (starts with `sk-ant-api03-...`)
12. Click **Save**

### Add rate limiting storage (recommended)

13. Go to **Workers & Pages** → **KV** → **Create namespace**
14. Name it: `GW_RATE_LIMIT`
15. Go back to your Worker → **Settings** → **Variables**
16. Under **KV Namespace Bindings**, click **Add binding**
17. Variable name: `KV`, Namespace: `GW_RATE_LIMIT`
18. Click **Save**

### Update your app

19. Open `gardenwise_app.html`
20. Find the line near the top of the `<script>` section:
    ```
    const PROXY_URL = 'https://REPLACE_WITH_YOUR_WORKER_URL.workers.dev';
    ```
21. Replace `REPLACE_WITH_YOUR_WORKER_URL.workers.dev` with your actual Worker URL

---

## Method B: Wrangler CLI (for developers)

```bash
# Install Wrangler
npm install -g wrangler

# Log in to Cloudflare
wrangler login

# Deploy the worker
wrangler deploy

# Set your secret API key (you'll be prompted to paste it)
wrangler secret put ANTHROPIC_API_KEY

# Create KV namespace for rate limiting
wrangler kv:namespace create "GW_RATE_LIMIT"
# Copy the ID it prints, paste into wrangler.toml
wrangler deploy  # redeploy with KV binding
```

---

## Verifying it works

After deploying, test the proxy directly:

```bash
curl -X POST https://gardenwise-proxy.YOURNAME.workers.dev/api/claude \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":100,"messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

You should get back a JSON response with the AI's reply.

---

## Cost estimates

Cloudflare Workers free tier: **100,000 requests/day** — more than enough for launch.
The only real cost is the Anthropic API itself:

| Users           | Daily AI calls | Monthly Anthropic cost |
|-----------------|----------------|------------------------|
| 500 free users  | ~2,500         | ~$7                    |
| 200 Plus users  | ~3,000         | ~$9                    |
| 100 Pro users   | ~2,000         | ~$6                    |
| **Total**       | ~7,500/day     | **~$22/month**         |

At $4.99 × 200 Plus users = **$998/month revenue** against ~$22 in API costs.

---

## Security checklist before launch

- [ ] `ANTHROPIC_API_KEY` set as a Secret (not a plain variable)
- [ ] KV namespace bound for rate limiting
- [ ] `ALLOWED_ORIGINS` in worker.js updated with your real domain
- [ ] App's `PROXY_URL` constant updated with your Worker URL
- [ ] Tested with curl — getting valid responses
- [ ] Tested with the app — AI Advisor and Species ID working
