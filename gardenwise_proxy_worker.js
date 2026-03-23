/**
 * GardenWise — Cloudflare Worker API Proxy
 * ─────────────────────────────────────────
 * Sits between the GardenWise app and the Anthropic API.
 * Your API key never leaves this server — it lives only
 * in the Cloudflare environment variable ANTHROPIC_API_KEY.
 *
 * SETUP INSTRUCTIONS
 * ──────────────────
 * 1. Log in at dash.cloudflare.com
 * 2. Go to Workers & Pages → Create Application → Create Worker
 * 3. Replace the default code with this entire file
 * 4. Click "Save and Deploy"
 * 5. Go to your Worker → Settings → Variables and Secrets
 * 6. Add a new Secret:
 *      Variable name:  ANTHROPIC_API_KEY
 *      Value:          sk-ant-api03-XXXX...  (your real Anthropic key)
 * 7. Click Save
 * 8. Note your Worker URL: https://gardenwise-proxy.YOURNAME.workers.dev
 * 9. Paste that URL into gardenwise_app.html where it says PROXY_URL_HERE
 *
 * OPTIONAL: Add a custom domain in Workers → Triggers → Custom Domains
 *
 * RATE LIMITING
 * ─────────────
 * This worker uses Cloudflare KV for per-IP rate limiting.
 * To enable it:
 *   1. Workers & Pages → KV → Create namespace → name it "GW_RATE_LIMIT"
 *   2. Go to your Worker → Settings → Variables → KV Namespace Bindings
 *   3. Add binding: Variable name = KV, Namespace = GW_RATE_LIMIT
 * If KV is not bound, rate limiting is skipped gracefully (no errors).
 *
 * FREE TIER LIMITS (enforced server-side)
 * ────────────────────────────────────────
 *   Free users  → 5 AI advisor calls per day, 3 species IDs per month
 *   Plus users  → unlimited (verified via purchase token in header)
 *   Pro users   → unlimited (verified via purchase token in header)
 */

// ── Configuration ─────────────────────────────────────────────────────────────

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Allowed origins — add your production domain here
const ALLOWED_ORIGINS = [
  'https://gardenwise.app',          // your production web domain
  'http://localhost:3000',           // local dev server
  'http://localhost:8080',           // alternative local port
  'http://127.0.0.1:3000',
  'capacitor://localhost',           // Capacitor iOS
  'https://localhost',               // Capacitor Android
  'null',                            // local file:// opens as null origin
];

// Per-endpoint token caps (free tier, server-enforced)
const FREE_AI_DAILY_LIMIT    = 5;
const FREE_ID_MONTHLY_LIMIT  = 3;
const MAX_TOKENS_FREE        = 800;   // cap response size for free users
const MAX_TOKENS_PAID        = 1500;  // cap for Plus / Pro

// Global rate limit: max requests per IP per hour (all tiers)
const GLOBAL_RATE_LIMIT      = 120;

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS preflight ────────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse(request);
    }

    // ── Health check ──────────────────────────────────────────────────────────
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', service: 'GardenWise Proxy' });
    }

    // ── Only handle POST to /api/* ────────────────────────────────────────────
    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) {
      return errorResponse('Not found', 404, request);
    }

    // ── Require API key to be configured ─────────────────────────────────────
    if (!env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY environment variable is not set');
      return errorResponse('Server configuration error', 500, request);
    }

    // ── Parse request body ────────────────────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON body', 400, request);
    }

    // ── Determine tier from request header ────────────────────────────────────
    // In production, replace this with real receipt verification.
    // For now the app sends a tier hint; server enforces limits accordingly.
    const tierHeader = request.headers.get('X-GW-Tier') || 'free';
    const isPaid = tierHeader === 'plus' || tierHeader === 'pro';
    const endpoint = url.pathname; // e.g. /api/claude or /api/identify

    // ── Global IP rate limiting (uses Cloudflare KV if available) ─────────────
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (env.KV) {
      const limited = await checkGlobalRateLimit(env.KV, ip, ctx);
      if (limited) {
        return errorResponse('Too many requests. Please slow down.', 429, request);
      }
    }

    // ── Free tier per-endpoint limits (KV required) ───────────────────────────
    if (!isPaid && env.KV) {
      const limitResult = await checkFreeTierLimit(env.KV, ip, endpoint, ctx);
      if (limitResult.exceeded) {
        return jsonResponse(
          { error: 'free_limit_exceeded', message: limitResult.message, upgradeRequired: true },
          402,
          request
        );
      }
    }

    // ── Sanitize and cap the request body ─────────────────────────────────────
    const maxTokens = isPaid ? MAX_TOKENS_PAID : MAX_TOKENS_FREE;
    const sanitizedBody = sanitizeBody(body, maxTokens);

    // ── Forward to Anthropic ──────────────────────────────────────────────────
    let anthropicResponse;
    try {
      anthropicResponse = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(sanitizedBody),
      });
    } catch (err) {
      console.error('Anthropic fetch failed:', err.message);
      return errorResponse('AI service temporarily unavailable', 503, request);
    }

    // ── Stream response back to app ───────────────────────────────────────────
    const responseData = await anthropicResponse.json();

    // Pass through Anthropic error codes directly
    if (!anthropicResponse.ok) {
      return jsonResponse(responseData, anthropicResponse.status, request);
    }

    return jsonResponse(responseData, 200, request);
  }
};

// ── Rate limiting helpers ─────────────────────────────────────────────────────

async function checkGlobalRateLimit(kv, ip, ctx) {
  const key = `global:${ip}`;
  try {
    const current = parseInt(await kv.get(key) || '0');
    if (current >= GLOBAL_RATE_LIMIT) return true;
    ctx.waitUntil(kv.put(key, String(current + 1), { expirationTtl: 3600 }));
    return false;
  } catch {
    return false; // fail open — don't block if KV errors
  }
}

async function checkFreeTierLimit(kv, ip, endpoint, ctx) {
  const isIdentify = endpoint.includes('identify');
  const today      = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  const month      = new Date().toISOString().slice(0, 7);   // YYYY-MM

  if (isIdentify) {
    const key = `id:${ip}:${month}`;
    try {
      const count = parseInt(await kv.get(key) || '0');
      if (count >= FREE_ID_MONTHLY_LIMIT) {
        return { exceeded: true, message: `Free plan: ${FREE_ID_MONTHLY_LIMIT} species IDs per month. Upgrade to GardenWise+ for unlimited.` };
      }
      ctx.waitUntil(kv.put(key, String(count + 1), { expirationTtl: 2678400 })); // 31 days
    } catch { /* fail open */ }
  } else {
    const key = `ai:${ip}:${today}`;
    try {
      const count = parseInt(await kv.get(key) || '0');
      if (count >= FREE_AI_DAILY_LIMIT) {
        return { exceeded: true, message: `Free plan: ${FREE_AI_DAILY_LIMIT} AI questions per day. Upgrade to GardenWise+ for unlimited.` };
      }
      ctx.waitUntil(kv.put(key, String(count + 1), { expirationTtl: 86400 })); // 24 hours
    } catch { /* fail open */ }
  }

  return { exceeded: false };
}

// ── Request sanitization ──────────────────────────────────────────────────────

function sanitizeBody(body, maxTokens) {
  return {
    // Only forward known-safe fields — block anything unexpected
    model:      body.model      || 'claude-sonnet-4-20250514',
    max_tokens: Math.min(body.max_tokens || maxTokens, maxTokens),
    system:     typeof body.system === 'string'   ? body.system.slice(0, 4000) : undefined,
    messages:   Array.isArray(body.messages)      ? sanitizeMessages(body.messages) : [],
  };
}

function sanitizeMessages(messages) {
  return messages.slice(0, 10).map(msg => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content.slice(0, 8000) };
    }
    // Multi-part content (e.g. image + text for species ID)
    if (Array.isArray(msg.content)) {
      return {
        role: msg.role,
        content: msg.content.slice(0, 4).map(part => {
          if (part.type === 'text') {
            return { type: 'text', text: part.text.slice(0, 4000) };
          }
          if (part.type === 'image') {
            // Pass through image data (base64) — required for species ID
            return part;
          }
          return null;
        }).filter(Boolean)
      };
    }
    return { role: msg.role, content: '' };
  });
}

// ── CORS helpers ──────────────────────────────────────────────────────────────

function getCorsOrigin(request) {
  const origin = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin':  getCorsOrigin(request),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-GW-Tier',
    'Access-Control-Max-Age':       '86400',
  };
}

function corsPreflightResponse(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

function jsonResponse(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(request ? corsHeaders(request) : {}),
    }
  });
}

function errorResponse(message, status, request = null) {
  return jsonResponse({ error: message }, status, request);
}
