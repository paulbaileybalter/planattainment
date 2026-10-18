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
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyBpZD0iTGF5ZXJfMSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB2ZXJzaW9uPSIxLjEiIHZpZXdCb3g9IjAgMCAxNjEgMTYxIj4KICA8IS0tIEdlbmVyYXRvcjogQWRvYmUgSWxsdXN0cmF0b3IgMzAuMi4xLCBTVkcgRXhwb3J0IFBsdWctSW4gLiBTVkcgVmVyc2lvbjogMi4xLjEgQnVpbGQgMSkgIC0tPgogIDxkZWZzPgogICAgPHN0eWxlPgogICAgICAuc3QwIHsKICAgICAgICBmaWxsOiAjNmNjNWE1OwogICAgICB9CiAgICA8L3N0eWxlPgogIDwvZGVmcz4KICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMTM2LjMsNzAuNGwtOS40LTkuNGMtMS42LTEuNi00LjMtMS42LTYsMC0xLjYsMS42LTEuNiw0LjMsMCw2bDIuMywyLjNjLTkuNiwxMy4yLTI1LjIsMjEuNy00Mi43LDIxLjdzLTMzLjEtOC42LTQyLjctMjEuOGwyLjMtMi4zYzEuNi0xLjYsMS42LTQuMywwLTYtMS42LTEuNi00LjMtMS42LTYsMGwtOS40LDkuNGMtMS42LDEuNi0xLjYsNC4zLDAsNiwuOC44LDEuOSwxLjIsMywxLjJzMi4yLS40LDMtMS4ybDEuMS0xLjFjMTEuMiwxNC43LDI4LjksMjQuMiw0OC43LDI0LjJzMzcuNS05LjUsNDguNy0yNC4ybDEuMSwxLjFjLjguOCwxLjksMS4yLDMsMS4yczIuMi0uNCwzLTEuMmMxLjYtMS42LDEuNi00LjMsMC02Ii8+CiAgPHBhdGggY2xhc3M9InN0MCIgZD0iTTE1Mi41LDguNXYxNDRIOC41VjguNWgxNDRNMTYxLDBIMHYxNjFoMTYxVjBoMFoiLz4KPC9zdmc+">
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
// Google Sheet fetch (/api/sheet)
//
// Pulls the whole workbook as .xlsx from Google and hands the bytes to the
// browser, which parses it with the same SheetJS code used for manual
// uploads. Only reachable once signed in (the auth check runs first).
//
// Two modes, chosen automatically:
//   1. Service account (private sheet): used if the GOOGLE_SERVICE_ACCOUNT_JSON
//      secret is set. The sheet is shared with the service account's email
//      as a Viewer, and the Drive API exports it.
//   2. Link sharing (default): the sheet is set to "Anyone with the link can
//      view" and the public export URL is used. No secret needed.
//
// SHEET_ID comes from wrangler.jsonc "vars" (or a secret of the same name).
// ---------------------------------------------------------------------------

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SHEET_CACHE_MS = 60 * 1000; // don't hit Google more than once a minute per isolate

let sheetCache = null;   // { at: number, bytes: ArrayBuffer }
let saTokenCache = null; // { token: string, exp: number }

function jsonError(status, error, hint) {
  return new Response(JSON.stringify({ error, hint }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function textToBase64Url(text) {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

async function getServiceAccountToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (saTokenCache && saTokenCache.exp - 60 > now) return saTokenCache.token;

  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${textToBase64Url(JSON.stringify(header))}.${textToBase64Url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${bytesToBase64Url(new Uint8Array(sig))}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!resp.ok) throw new Error(`Google token exchange failed (${resp.status})`);
  const data = await resp.json();
  saTokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return saTokenCache.token;
}

async function fetchSheetBytes(env) {
  const id = env.SHEET_ID;
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const token = await getServiceAccountToken(env);
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const err = new Error(`Drive API export failed (${resp.status})`);
      err.hint = "Check the sheet is shared with the service account's email as a Viewer, and that the Google Drive API is enabled for its project.";
      throw err;
    }
    return resp.arrayBuffer();
  }

  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=xlsx`;
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) {
    const err = new Error(`Google returned ${resp.status}`);
    err.hint = "Check the sheet's sharing is set to 'Anyone with the link' as Viewer.";
    throw err;
  }
  const bytes = await resp.arrayBuffer();
  // A real .xlsx is a zip file and starts with "PK". An HTML sign-in page doesn't.
  const head = new Uint8Array(bytes.slice(0, 2));
  if (head[0] !== 0x50 || head[1] !== 0x4b) {
    const err = new Error("Google returned a web page instead of the spreadsheet");
    err.hint = "The sheet is probably not shared as 'Anyone with the link' (Viewer).";
    throw err;
  }
  return bytes;
}

async function handleSheet(request, env) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  if (!env.SHEET_ID) {
    return jsonError(501, "No sheet configured", "Set SHEET_ID in wrangler.jsonc vars.");
  }

  const force = new URL(request.url).searchParams.get("refresh") === "1";
  const now = Date.now();
  let bytes;
  let fetchedAt;
  if (sheetCache && !force && now - sheetCache.at < SHEET_CACHE_MS) {
    bytes = sheetCache.bytes;
    fetchedAt = sheetCache.at;
  } else {
    try {
      bytes = await fetchSheetBytes(env);
    } catch (e) {
      console.error("sheet fetch failed:", e && e.message);
      return jsonError(502, (e && e.message) || "Sheet fetch failed", e && e.hint);
    }
    fetchedAt = now;
    sheetCache = { at: fetchedAt, bytes };
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": XLSX_MIME,
      "Cache-Control": "no-store",
      "X-Fetched-At": new Date(fetchedAt).toISOString(),
    },
  });
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

    // --- Google Sheet feed, only reachable once authenticated ---
    if (path === "/api/sheet") {
      return handleSheet(request, env);
    }

    // --- Static site files ---
    return env.ASSETS.fetch(request);
  },
};
