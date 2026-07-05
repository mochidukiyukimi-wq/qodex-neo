import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const sessionSecret = mustEnv("SESSION_SECRET");
const dataPath = process.env.SESSION_FILE || "/tmp/qodex-sessions.json";

const traq = {
  origin: "https://q.trap.jp",
  api: "https://q.trap.jp/api/v3",
  auth: "https://q.trap.jp/api/v3/oauth2/authorize",
  token: "https://q.trap.jp/api/v3/oauth2/token",
  clientId: mustEnv("TRAQ_CLIENT_ID"),
  clientSecret: mustEnv("TRAQ_CLIENT_SECRET"),
  redirectUrl: process.env.TRAQ_REDIRECT_URL || `${baseUrl}/oauth/callback`,
  allowedUser: process.env.ALLOWED_TRAQ_USER || "",
  allowedUserId: process.env.ALLOWED_TRAQ_USER_ID || "",
  allowedPostChannelPath: process.env.ALLOWED_POST_CHANNEL_PATH || "",
};

const ai = {
  url: mustEnv("QODEX_AI_API_URL").replace(/\/$/, ""),
  token: mustEnv("QODEX_AI_API_TOKEN"),
};

app.use(express.json({ limit: "1mb" }));

app.get("/login", async (req, res) => {
  const session = await getSession(req, res);
  session.oauthState = random();
  session.codeVerifier = random(64);
  await saveSession(session);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: traq.clientId,
    redirect_uri: traq.redirectUrl,
    scope: "read write",
    state: session.oauthState,
    code_challenge: base64url(crypto.createHash("sha256").update(session.codeVerifier).digest()),
    code_challenge_method: "S256",
  });
  res.redirect(`${traq.auth}?${params}`);
});

app.get("/oauth/callback", async (req, res) => {
  const session = await getSession(req, res);
  if (!req.query.code || req.query.state !== session.oauthState) {
    return res.status(400).send("OAuth state mismatch");
  }

  const token = await tokenRequest({
    grant_type: "authorization_code",
    code: String(req.query.code),
    redirect_uri: traq.redirectUrl,
    code_verifier: session.codeVerifier,
  });
  session.token = sealToken(token);
  delete session.oauthState;
  delete session.codeVerifier;

  const me = await traqFetch(session, "/users/me");
  if (!isAllowedUser(me)) {
    delete session.token;
    delete session.user;
    await saveSession(session);
    return res.status(403).send(`Only the configured traQ user can use this QodeX.`);
  }
  session.user = { id: me.id, name: me.name, displayName: me.displayName };
  await saveSession(session);
  res.redirect("/");
});

app.post("/logout", async (req, res) => {
  const session = await getSession(req, res);
  delete session.token;
  delete session.user;
  await saveSession(session);
  res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  try {
    const session = await getSession(req, res);
    if (!session.token) return res.json({ loggedIn: false });
    const user = await ensureAllowed(session);
    res.json({ loggedIn: true, user });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/channels", authed(async (req, res, session) => {
  res.json({ channels: (await getChannels(session)).filter(c => !c.archived).slice(0, 120) });
}));

app.post("/api/resolve-channel", authed(async (req, res, session) => {
  const input = String(req.body.input || "").trim();
  const channels = await getChannels(session);
  const channel = resolveChannel(channels, input);
  if (!channel) return res.status(404).json({ error: "channel not found" });
  res.json({ channel });
}));

app.post("/api/messages", authed(async (req, res, session) => {
  const channelId = String(req.body.channelId || "");
  if (!channelId) return res.status(400).json({ error: "channelId is required" });
  res.json({ messages: await getMessages(session, channelId) });
}));

app.post("/api/review", authed(async (req, res, session) => {
  const channelId = String(req.body.channelId || "");
  const draft = String(req.body.draft || "").trim();
  if (!channelId || !draft) return res.status(400).json({ error: "channelId and draft are required" });

  const context = await getMessages(session, channelId);
  const review = await aiFetch("/review", { draft, context });

  if (review.action === "pass") {
    const message = await postMessage(session, channelId, draft);
    return res.json({ action: "posted", message });
  }
  res.json({ action: "stop", warning: review.warning || "このまま送る前に一度考えた方がよさそうです。", context });
}));

app.post("/api/rewrite", authed(async (req, res, session) => {
  const channelId = String(req.body.channelId || "");
  const originalDraft = String(req.body.originalDraft || "").trim();
  const warning = String(req.body.warning || "").trim();
  const userIntent = String(req.body.userIntent || "").trim();
  if (!channelId || !originalDraft || !userIntent) {
    return res.status(400).json({ error: "channelId, originalDraft, and userIntent are required" });
  }

  const context = await getMessages(session, channelId);
  const result = await aiFetch("/rewrite", { originalDraft, warning, userIntent, context });
  res.json({ post: result.post || "" });
}));

app.post("/api/post", authed(async (req, res, session) => {
  const channelId = String(req.body.channelId || "");
  const content = String(req.body.content || "").trim();
  if (!channelId || !content) return res.status(400).json({ error: "channelId and content are required" });
  res.json({ message: await postMessage(session, channelId, content) });
}));

app.get("/qodex-auth.js", (req, res) => {
  res.type("application/javascript").send(`
(() => {
  navigator.serviceWorker?.getRegistrations?.().then(rs => rs.forEach(r => r.unregister()));
  const go = () => {
    if (location.hostname === "qodex.trap.show" && location.pathname === "/login") {
      location.replace("/login?oauth=1");
    }
  };
  go();
  setInterval(go, 1000);
})();
`);
});

app.get(["/sw.js", "/service-worker.js"], (req, res) => {
  res.type("application/javascript").set("cache-control", "no-store").send("");
});

app.all("/api/v3/channels/:channelId/messages", authed(async (req, res, session) => {
  if (req.method !== "POST") return proxyTraqApi(req, res, session);
  await assertAllowedPostChannel(session, req.params.channelId);

  const content = String(req.body.content || "").trim();
  if (!content) return res.status(400).json({ message: "content is required" });

  const context = await getMessages(session, req.params.channelId);
  const review = await aiFetch("/review", { draft: content, context });
  if (review.action !== "pass") {
    return res.status(400).json({
      message: `QodeX warning: ${review.warning || "AI review stopped this post."}`,
      warning: review.warning || "",
    });
  }
  return proxyTraqApi(req, res, session);
}));

app.all("/api/v3/*", authed(proxyTraqApi));

app.get("*", async (req, res) => {
  const session = await getSession(req, res);
  const wantsHtml = String(req.headers.accept || "").includes("text/html");
  if (wantsHtml && !session.token) return res.redirect("/login");
  return proxyTraqFrontend(req, res);
});

app.listen(port, () => {
  console.log(`QodeX listening on ${baseUrl}`);
});

function mustEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function random(bytes = 32) {
  return base64url(crypto.randomBytes(bytes));
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");
}

async function getSession(req, res) {
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(c => {
    const [k, ...v] = c.trim().split("=");
    return [k, decodeURIComponent(v.join("="))];
  }));
  let sid = cookies.qodex_sid?.split(".")[0];
  const sig = cookies.qodex_sid?.split(".")[1];
  if (!sid || sig !== sign(sid)) sid = random();

  const sessions = await readSessions();
  const session = sessions[sid] || { id: sid };
  res.cookie("qodex_sid", `${sid}.${sign(sid)}`, { httpOnly: true, sameSite: "lax", secure: baseUrl.startsWith("https://"), maxAge: 30 * 24 * 3600 * 1000 });
  return session;
}

async function readSessions() {
  try {
    return JSON.parse(await fs.readFile(dataPath, "utf8"));
  } catch {
    await fs.mkdir(path.dirname(dataPath), { recursive: true });
    return {};
  }
}

async function saveSession(session) {
  const sessions = await readSessions();
  sessions[session.id] = session;
  await fs.writeFile(dataPath, JSON.stringify(sessions, null, 2));
}

function sealToken(token) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(sessionSecret).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ ...token, obtained_at: Date.now() })), cipher.final()]);
  return { iv: base64url(iv), tag: base64url(cipher.getAuthTag()), data: base64url(data) };
}

function openToken(sealed) {
  const key = crypto.createHash("sha256").update(sessionSecret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64url")), decipher.final()]).toString("utf8"));
}

async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: traq.clientId, client_secret: traq.clientSecret, ...params });
  const res = await fetch(traq.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`traQ token error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ensureToken(session) {
  let token = openToken(session.token);
  const expiresAt = token.obtained_at + Math.max(0, Number(token.expires_in || 0) - 60) * 1000;
  if (token.refresh_token && Date.now() > expiresAt) {
    token = await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh_token });
    session.token = sealToken(token);
    await saveSession(session);
  }
  return token.access_token;
}

async function traqFetch(session, apiPath, options = {}) {
  const accessToken = await ensureToken(session);
  const res = await fetch(`${traq.api}${apiPath}`, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`traQ API error ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function proxyTraqApi(req, res, session) {
  const accessToken = await ensureToken(session);
  const upstream = await fetch(`${traq.origin}${req.originalUrl}`, {
    method: req.method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": req.headers["content-type"] || "application/json",
    },
    body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
  });
  await pipeFetchResponse(upstream, res);
}

async function proxyTraqFrontend(req, res) {
  const upstream = await fetch(`${traq.origin}${req.originalUrl}`, {
    headers: { accept: req.headers.accept || "*/*" },
  });
  const type = upstream.headers.get("content-type") || "";
  if (!type.includes("text/html")) return pipeFetchResponse(upstream, res);

  res.status(upstream.status).type("html").set("cache-control", "no-store").send(
    (await upstream.text()).replace("</head>", `<script src="/qodex-auth.js"></script></head>`)
  );
}

async function pipeFetchResponse(upstream, res) {
  res.status(upstream.status);
  for (const key of ["content-type", "cache-control", "etag", "last-modified"]) {
    const value = upstream.headers.get(key);
    if (value) res.setHeader(key, value);
  }
  res.send(Buffer.from(await upstream.arrayBuffer()));
}

function authed(handler) {
  return async (req, res) => {
    try {
      const session = await getSession(req, res);
      if (!session.token) return res.status(401).json({ error: "login required" });
      await ensureAllowed(session);
      await handler(req, res, session);
    } catch (err) {
      console.error(err);
      res.status(err.status || 500).json({ error: err.message });
    }
  };
}

async function ensureAllowed(session) {
  const me = session.user || (await traqFetch(session, "/users/me"));
  if (!isAllowedUser(me)) {
    delete session.token;
    delete session.user;
    await saveSession(session);
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  session.user = { id: me.id, name: me.name, displayName: me.displayName };
  await saveSession(session);
  return session.user;
}

function isAllowedUser(user) {
  if (!traq.allowedUser && !traq.allowedUserId) return true;
  return (!traq.allowedUser || user.name === traq.allowedUser)
    && (!traq.allowedUserId || user.id === traq.allowedUserId);
}

async function getChannels(session) {
  const data = await traqFetch(session, "/channels");
  const all = [...(data.public || []), ...(data.dm || [])];
  const byId = new Map(all.map(c => [c.id, c]));
  return all.map(c => ({ id: c.id, name: c.name, path: channelPath(c, byId), archived: c.archived }));
}

function channelPath(channel, byId) {
  const names = [];
  const seen = new Set();
  let cur = channel;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.push(cur.name);
    cur = byId.get(cur.parentId);
  }
  return names.reverse().join("/");
}

function resolveChannel(channels, input) {
  const urlMatch = input.match(/q\.trap\.jp\/channels\/([^?#]+)/);
  const value = decodeURIComponent(urlMatch ? urlMatch[1] : input).replace(/^#/, "").replace(/^\/+/, "");
  return channels.find(c => c.id === value) || channels.find(c => c.path === value) || channels.find(c => c.path.endsWith(`/${value}`));
}

async function assertAllowedPostChannel(session, channelId) {
  const allowedPath = traq.allowedPostChannelPath;
  if (!allowedPath) return;
  const channel = (await getChannels(session)).find(c => c.id === channelId);
  if (channel?.path === allowedPath) return;
  const err = new Error(`QodeX only posts to #${allowedPath}`);
  err.status = 403;
  throw err;
}

async function getMessages(session, channelId) {
  const now = new Date();
  const since = new Date(now.getTime() - 90 * 60 * 1000).toISOString();
  const params = new URLSearchParams({ limit: "60", since, inclusive: "true", order: "asc" });
  const messages = await traqFetch(session, `/channels/${channelId}/messages?${params}`);
  const users = await traqFetch(session, "/users?include-suspended=true");
  const names = new Map(users.map(u => [u.id, u.name]));
  return messages.map(m => ({
    user: names.get(m.userId) || m.userId,
    at: m.createdAt,
    content: m.content,
  }));
}

async function postMessage(session, channelId, content) {
  return traqFetch(session, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

async function aiFetch(apiPath, body) {
  const res = await fetch(`${ai.url}${apiPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ai.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`QodeX AI error ${res.status}: ${await res.text()}`);
  return res.json();
}
