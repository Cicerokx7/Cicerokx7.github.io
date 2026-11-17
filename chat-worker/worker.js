import { JACK_VOICE_INSTRUCTIONS } from "./instructions.js";

const ALLOWED_ORIGINS = [
  "https://jackojones.com",
  "https://www.jackojones.com",
  "https://cicerokx7.github.io",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
];

const rateMap = new Map();

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const maxPerWindow = 10;
  let entry = rateMap.get(ip);
  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 0 };
    rateMap.set(ip, entry);
  }
  entry.count += 1;
  return entry.count > maxPerWindow;
}

function safetyId(ip) {
  // Stable-ish opaque id for OpenAI safety identifier (not the raw IP).
  let hash = 0;
  const s = `jack-site:${ip}`;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return `visitor-${hash.toString(16)}`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (path !== "/token" && path !== "/api/token") {
      return json({ error: "Not found" }, 404, origin);
    }

    if (request.method !== "POST" && request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, origin);
    }

    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "Origin not allowed" }, 403, origin);
    }

    const ip = clientIp(request);
    if (rateLimited(ip)) {
      return json({ error: "Too many requests. Please wait a minute." }, 429, origin);
    }

    if (!env.OPENAI_API_KEY) {
      return json({ error: "Voice chat is not configured yet." }, 503, origin);
    }

    const model = env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1";
    const voice = env.OPENAI_VOICE || "marin";

    try {
      const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": safetyId(ip),
        },
        body: JSON.stringify({
          expires_after: { anchor: "created_at", seconds: 600 },
          session: {
            type: "realtime",
            model,
            instructions: JACK_VOICE_INSTRUCTIONS,
            audio: {
              output: { voice },
            },
          },
        }),
      });

      const data = await upstream.json();
      if (!upstream.ok) {
        console.error("client_secrets error", data);
        return json({ error: "Could not start a ChatGPT voice session." }, 502, origin);
      }

      const value = data.value || data.client_secret?.value;
      if (!value) {
        return json({ error: "Unexpected token response from OpenAI." }, 502, origin);
      }

      return json({ value, expires_at: data.expires_at || data.client_secret?.expires_at }, 200, origin);
    } catch (err) {
      console.error(err);
      return json({ error: "Voice chat service failed." }, 500, origin);
    }
  },
};
