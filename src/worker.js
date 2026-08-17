/**
 * Worker entry point for the Balter Brewing Production Attainment dashboard.
 *
 * Responsibilities, in order, for every incoming request:
 *   1. Password-gate the whole site via a signed, HttpOnly session cookie.
 *      Nothing — not even static files — is served without a valid session,
 *      except the /login route itself (or the cookie would never be
 *      obtainable in the first place).
 *   2. Once authenticated, fall through to the static assets in ./public
 *      via the ASSETS binding for everything else.
 *
 * There is no server-side data sync in this build: the weekly spreadsheet
 * is parsed entirely in the browser after upload and never leaves the
 * uploader's device. Only two secrets are required.
 *
 * Required Worker secrets (Settings -> Variables and Secrets, type "Secret"):
 *   SITE_PASSWORD   - the shared password everyone types in to get in
 *   SESSION_SECRET  - random string used to HMAC-sign session cookies
 */

const COOKIE_NAME = "session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signPayload(payload, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64Url(new Uint8Array(sig));
}

async function verifyPayload(payload, signature, secret) {
  const key = await hmacKey(secret);
  let sigBytes;
  try {
    sigBytes = base64UrlToBytes(signature);
  } catch (e) {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payload));
}

// Constant-time-ish string comparison: hash both sides first (fixed-length
// output) so the final comparison loop doesn't leak input length or content
// through timing, then compare byte-by-byte without short-circuiting.
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode("timing-safe-compare-key"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const [da, db] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(String(a))),
    crypto.subtle.sign("HMAC", key, enc.encode(String(b))),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Session cookie
// ---------------------------------------------------------------------------

async function createSessionToken(env) {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = String(expiry);
  const sig = await signPayload(payload, env.SESSION_SECRET);
  return `${payload}.${sig}`;
}

async function isValidSessionToken(token, env) {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expiry = Number(payload);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  return verifyPayload(payload, sig, env.SESSION_SECRET);
}

function parseCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

function sessionCookieHeader(token, maxAgeSeconds) {
  return (
    `${COOKIE_NAME}=${encodeURIComponent(token)}; ` +
    `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  );
}

async function requestIsAuthenticated(request, env) {
  const token = parseCookie(request, COOKIE_NAME);
  return isValidSessionToken(token, env);
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

function loginPageHtml(errorMessage) {
  const errorBlock = errorMessage
    ? `<div class="error">${escapeHtml(errorMessage)}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sign in — Balter Production Attainment</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;}
  body{
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family:'Lexend', system-ui, sans-serif; background:
      radial-gradient(1200px 500px at 100% -10%, rgba(153,214,234,.25), transparent 60%),
      radial-gradient(900px 400px at -10% 110%, rgba(255,214,55,.18), transparent 55%),
      #FFFFFF;
    color:#0B0B0C;
  }
  .card{
    width:100%; max-width:360px; margin:20px; background:#fff; border:1px solid #E7E5DE;
    border-radius:14px; box-shadow:0 6px 20px rgba(11,11,12,.08); overflow:hidden;
  }
  .bar{height:4px; background:#47D7AC;}
  .inner{padding:28px 26px 26px;}
  .logo{width:38px; height:38px; margin-bottom:10px;}
  .logo svg{width:100%; height:100%; display:block;}
  h1{font-size:19px; font-weight:700; margin:0 0 4px;}
  .sub{font-size:13px; color:#7a776c; margin:0 0 18px;}
  input[type=password]{
    width:100%; padding:11px 12px; border:1.5px solid #E7E5DE; border-radius:9px;
    font-size:14px; font-family:inherit; margin-bottom:14px; background:#FAFAF7; color:#0B0B0C;
  }
  input[type=password]:focus{outline:2px solid #47D7AC; outline-offset:0; border-color:#47D7AC;}
  button{
    width:100%; padding:11px 12px; border:none; border-radius:9px; background:#0B0B0C;
    color:#fff; font-family:inherit; font-size:14px; font-weight:700; cursor:pointer;
  }
  button:hover{background:#7566A0;}
  .error{
    background:rgba(117,102,160,.1); border:1px solid #7566A0; color:#4a3f68;
    font-size:12.5px; padding:9px 11px; border-radius:8px; margin-bottom:14px;
  }
</style>
</head>
<body>
  <form class="card" method="POST" action="/login">
    <div class="bar"></div>
    <div class="inner">
      <div class="logo"><svg viewBox="0 0 161 161" xmlns="http://www.w3.org/2000/svg"><path fill="#47D7AC" d="M136.3,70.4l-9.4-9.4c-1.6-1.6-4.3-1.6-6,0-1.6,1.6-1.6,4.3,0,6l2.3,2.3c-9.6,13.2-25.2,21.7-42.7,21.7s-33.1-8.6-42.7-21.8l2.3-2.3c1.6-1.6,1.6-4.3,0-6-1.6-1.6-4.3-1.6-6,0l-9.4,9.4c-1.6,1.6-1.6,4.3,0,6,.8.8,1.9,1.2,3,1.2s2.2-.4,3-1.2l1.1-1.1c11.2,14.7,28.9,24.2,48.7,24.2s37.5-9.5,48.7-24.2l1.1,1.1c.8.8,1.9,1.2,3,1.2s2.2-.4,3-1.2c1.6-1.6,1.6-4.3,0-6"/><path fill="#47D7AC" d="M152.5,8.5v144H8.5V8.5h144M161,0H0v161h161V0h0Z"/></svg></div>
      <h1>Balter Production Attainment</h1>
      <p class="sub">Enter the site password to continue.</p>
      ${errorBlock}
      <input type="password" name="password" placeholder="Password" autofocus required>
      <button type="submit">Sign in</button>
    </div>
  </form>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Login route: always reachable, never itself gated ---
    if (path === "/login") {
      if (request.method === "GET") {
        return new Response(loginPageHtml(null), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=UTF-8" },
        });
      }
      if (request.method === "POST") {
        const form = await request.formData();
        const submitted = form.get("password") || "";
        const expected = env.SITE_PASSWORD || "";
        const ok = expected && (await timingSafeEqual(submitted, expected));
        if (!ok) {
          return new Response(loginPageHtml("That password didn't work — try again."), {
            status: 401,
            headers: { "Content-Type": "text/html; charset=UTF-8" },
          });
        }
        const token = await createSessionToken(env);
        return new Response(null, {
          status: 303,
          headers: {
            Location: "/",
            "Set-Cookie": sessionCookieHeader(token, SESSION_TTL_MS / 1000),
          },
        });
      }
      return new Response("Method not allowed", { status: 405 });
    }

    // --- Logout: clears the cookie, always reachable ---
    if (path === "/logout" && request.method === "POST") {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/login",
          "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        },
      });
    }

    // --- Everything else requires a valid session ---
    const authed = await requestIsAuthenticated(request, env);
    if (!authed) {
      const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");
      if (wantsHtml || path === "/") {
        return Response.redirect(new URL("/login", request.url).toString(), 302);
      }
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- Static site files ---
    return env.ASSETS.fetch(request);
  },
};
