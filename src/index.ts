// --- Imports ---
// Express is the web framework that handles HTTP requests and responses
import express, { Request, Response } from "express";
// Middleware that limits how many requests a single IP can make (prevents abuse)
import rateLimit from "express-rate-limit";
// Node's built-in crypto module for generating random bytes
import crypto from "crypto";
// SQLite database driver — "better-sqlite3" is synchronous (no async/await needed)
import Database from "better-sqlite3";
// Node's built-in path module for constructing file paths that work on any OS
import path from "path";
// Redis client — an in-memory key-value store used as a cache.
// `createClient` is the function that creates a new connection to a Redis server.
import { createClient } from "redis";

// --- Config ---
// These values can be overridden via environment variables (useful in Docker)
// `process.env.PORT` reads from the environment; `|| 3000` is the fallback default
const PORT = Number(process.env.PORT) || 3000;
// Template literal (`backtick string`) lets us embed variables with ${...}
const BASE_URL = `http://localhost:${PORT}`;
// __dirname is the folder where this compiled JS file lives (dist/)
// path.join goes up one level (..) to put the database in the project root
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "urls.db");
// Redis connection URL. In Docker Compose, the hostname "redis" resolves to the Redis container.
// Locally, it defaults to localhost.
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// --- Types ---
// TypeScript interfaces define the "shape" of an object — what properties it has
// and what type each property is. They exist only at compile time (not in the JS output).

// Describes a single row from the "urls" table in SQLite
// Column names use snake_case to match the SQL convention
interface UrlRow {
  code: string;         // The short code (e.g. "abc123")
  original_url: string; // The full URL it points to
  created_at: string;   // ISO timestamp of when it was created
  visits: number;       // How many times the short URL has been visited
}

// Tells TypeScript what req.params looks like for routes with :code in the path
// Without this, req.params.code would be typed as string[] instead of string
interface CodeParam {
  code: string;
}

// --- Database setup (SQLite) ---

// Create (or open) the SQLite database file at DB_PATH
// This single `db` object is reused for every request (no need to open/close)
const db = new Database(DB_PATH);

// WAL = Write-Ahead Logging. By default, SQLite locks the entire database during writes.
// WAL mode lets reads happen while a write is in progress — much better for a web server.
db.pragma("journal_mode = WAL");

// Create the "urls" table if it doesn't already exist.
// This runs once on startup. If the table is already there, it's a no-op.
// PRIMARY KEY on `code` means each code must be unique and lookups by code are fast.
// NOT NULL means the column can't be empty. DEFAULT 0 sets the initial visit count.
db.exec(`
  CREATE TABLE IF NOT EXISTS urls (
    code        TEXT PRIMARY KEY,
    original_url TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    visits      INTEGER NOT NULL DEFAULT 0
  )
`);

// Prepared statements: SQL is parsed and compiled ONCE here, then reused on every request.
// This is faster than sending raw SQL strings each time.
// The ? placeholders are filled in later with .get() or .run() — this also prevents
// SQL injection because the values are never mixed into the SQL string itself.
// <[string], UrlRow> tells TypeScript: input is a string, output is a UrlRow.
const stmts = {
  findByUrl:       db.prepare<[string], UrlRow>("SELECT * FROM urls WHERE original_url = ?"),
  findByCode:      db.prepare<[string], UrlRow>("SELECT * FROM urls WHERE code = ?"),
  insert:          db.prepare("INSERT INTO urls (code, original_url, created_at, visits) VALUES (?, ?, ?, 0)"),
  listAll:         db.prepare("SELECT * FROM urls"),
  deleteByCode:    db.prepare("DELETE FROM urls WHERE code = ?"),
  incrementVisits: db.prepare("UPDATE urls SET visits = visits + 1 WHERE code = ?"),
};

// --- Redis setup (cache) ---
// Redis is an in-memory data store — it's like a giant JavaScript Map that lives
// in a separate process. Because it stores everything in RAM, lookups are extremely fast
// (microseconds vs milliseconds for SQLite disk reads).
//
// We use the "cache-aside" pattern:
//   1. On READ:  check Redis first → if found, return it (cache hit)
//                                   → if not found, query SQLite, store result in Redis, return it (cache miss)
//   2. On WRITE: write to SQLite first, then update/add to Redis
//   3. On DELETE: delete from SQLite first, then remove from Redis
//
// This way Redis always has a copy of frequently accessed data, and SQLite
// remains the "source of truth" (the authoritative, persistent store).

// Create a Redis client. This doesn't connect yet — we call .connect() later.
// `socket.connectTimeout` limits how long the initial connection attempt waits (3 seconds).
// `socket.reconnectStrategy` controls what happens when Redis disconnects:
//   - Returning a number means "retry after this many milliseconds"
//   - Returning false (after 3 attempts) means "stop trying and run without cache"
const redis = createClient({
  url: REDIS_URL,
  socket: {
    connectTimeout: 3000,
    reconnectStrategy: (retries) => (retries < 3 ? 1000 : false),
  },
});

// Track whether Redis is available. If Redis is down, we gracefully fall back to SQLite only.
// This is important: your app should NEVER crash just because the cache is unavailable.
let redisConnected = false;

// Redis emits events when things happen. "error" fires on connection failures.
// Without this listener, an unhandled error would crash the process.
redis.on("error", () => {
  if (redisConnected) {
    console.log("Redis disconnected — falling back to SQLite only");
    redisConnected = false;
  }
});

redis.on("ready", () => {
  console.log("Redis connected");
  redisConnected = true;
});

// --- Core logic ---

// Generates a random 6-character string safe for use in URLs.
// crypto.randomBytes(4) produces 4 random bytes (32 bits of randomness).
// .toString("base64url") encodes them as URL-safe characters (A-Z, a-z, 0-9, -, _).
// .slice(0, 6) trims to 6 characters. This gives ~2 billion possible codes.
function generateCode(): string {
  return crypto.randomBytes(4).toString("base64url").slice(0, 6);
}

// Takes user input like "github.com" or "https://github.com" and returns
// a valid, normalized URL — or null if the input is garbage.
// The return type `string | null` means it returns either a string or null.
function normalizeUrl(url: string): string | null {
  // Regex test: does the string start with http:// or https://?
  // If not, prepend https:// so "github.com" becomes "https://github.com"
  const withProtocol = /^https?:\/\//i.test(url) ? url : `https://${url}`;

  try {
    // `new URL()` is a built-in parser. If the string isn't a valid URL, it throws.
    const parsed = new URL(withProtocol);
    // Only allow http/https protocols — reject dangerous schemes like javascript: or data:
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    // .href returns the fully normalized URL (e.g. adds trailing slash, lowercases host)
    return parsed.href;
  } catch {
    // If new URL() threw, the input was not a valid URL
    return null;
  }
}

// --- Redis cache helpers ---
// These helper functions wrap Redis operations with error handling.
// If Redis is down, they silently return null/undefined instead of crashing.
// The prefix "url:" is a Redis key naming convention — it namespaces our keys
// so they don't collide with other data if we add more features later.

// Try to get a cached URL from Redis. Returns the URL string or null.
async function cacheGet(code: string): Promise<string | null> {
  if (!redisConnected) return null;
  try {
    return await redis.get("url:" + code);
  } catch {
    return null;
  }
}

// Store a URL in the Redis cache.
async function cacheSet(code: string, url: string): Promise<void> {
  if (!redisConnected) return;
  try {
    // SET with EX option: the key expires after 1 hour (3600 seconds).
    // This prevents stale data from living in the cache forever.
    // Even if we forget to invalidate, the worst case is a 1-hour delay.
    await redis.set("url:" + code, url, { EX: 3600 });
  } catch {
    // Cache write failed — not critical, SQLite still has the data
  }
}

// Remove a URL from the Redis cache (used when deleting a short URL).
async function cacheDel(code: string): Promise<void> {
  if (!redisConnected) return;
  try {
    await redis.del("url:" + code);
  } catch {
    // Cache delete failed — the key will expire naturally
  }
}

// --- Server ---

// Create the Express app — this is the core object that handles all HTTP traffic.
// Every request flows through middleware (like rate limiting) before reaching a route.
const app = express();

// express.json() is middleware that parses JSON request bodies.
// Without this, req.body would be undefined when someone POSTs JSON to our API.
app.use(express.json());

// app.use() applies middleware to ALL routes.
// This rate limiter allows 100 requests per 15-minute window from any single IP.
// If exceeded, Express automatically returns a 429 status with our error message.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes in milliseconds
  max: 100,                  // max requests per window per IP
  message: { error: "Too many requests, try again later" },
}));

// A separate, stricter limiter just for the shorten endpoint.
// This isn't applied globally with app.use() — instead it's passed directly
// to the route below as middleware (the second argument to app.post).
const shortenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // only 10 new URLs per 15 minutes per IP
  message: { error: "Too many URLs shortened, try again later" },
});

// GET / — serve the web UI
// When someone visits http://localhost:3000/ in their browser, send back this HTML page.
// The entire frontend is inline here — no separate HTML file needed.
app.get("/", (_req: Request, res: Response) => {
  // _req is prefixed with _ because we don't use the request object in this handler.
  // res.send() sends the HTML string as the HTTP response body.
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>URL Shortener</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; color: #333; }
    h1 { margin-bottom: 20px; }
    form { display: flex; gap: 8px; margin-bottom: 30px; }
    input { flex: 1; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 16px; }
    button { padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; font-size: 16px; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    #result { padding: 12px; background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; margin-bottom: 20px; display: none; word-break: break-all; }
    #result a { color: #2563eb; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e5e7eb; }
    th { font-weight: 600; }
    td a { color: #2563eb; text-decoration: none; }
    .visits { text-align: center; }
    .delete-btn { background: none; border: none; color: #ef4444; cursor: pointer; font-size: 14px; }
    .delete-btn:hover { text-decoration: underline; }
    .empty { color: #999; font-style: italic; }
  </style>
</head>
<body>
  <h1>URL Shortener</h1>

  <form id="shorten-form">
    <input type="text" id="url-input" placeholder="Paste a URL..." required />
    <button type="submit">Shorten</button>
  </form>

  <div id="result"></div>

  <h2 style="margin-bottom: 12px;">Your URLs</h2>
  <table>
    <thead><tr><th>Short</th><th>Original</th><th class="visits">Visits</th><th></th></tr></thead>
    <tbody id="url-list"></tbody>
  </table>

  <script>
    // --- Frontend JavaScript (runs in the browser, not in Node) ---
    // These getElementById calls grab references to DOM elements so we can update them.
    const form = document.getElementById("shorten-form");
    const input = document.getElementById("url-input");
    const result = document.getElementById("result");
    const urlList = document.getElementById("url-list");

    // Fetches all URLs from the /stats API and renders them into the table.
    // "async" means this function can use "await" to pause until a Promise resolves.
    async function loadUrls() {
      const res = await fetch("/stats");   // GET /stats — returns JSON array
      const urls = await res.json();       // Parse the JSON response body
      if (urls.length === 0) {
        urlList.innerHTML = '<tr><td colspan="4" class="empty">No URLs yet. Shorten one above!</td></tr>';
        return;
      }
      // .map() transforms each URL object into an HTML table row string
      // .join("") combines all the row strings into one big string
      urlList.innerHTML = urls.map(u =>
        '<tr>' +
          '<td><a href="' + u.shortUrl + '" target="_blank">' + u.code + '</a></td>' +
          '<td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + u.originalUrl + '</td>' +
          '<td class="visits">' + u.visits + '</td>' +
          '<td><button class="delete-btn" onclick="deleteUrl(\\''+u.code+'\\')">delete</button></td>' +
        '</tr>'
      ).join("");
    }

    // Listen for form submission. e.preventDefault() stops the browser from
    // doing a full page reload (the default form behavior).
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      // Send the URL to our API as a JSON POST request
      const res = await fetch("/shorten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: input.value })
      });
      const data = await res.json();
      // Show the result box with the shortened URL
      result.style.display = "block";
      result.innerHTML = 'Shortened: <a href="' + data.shortUrl + '" target="_blank">' + data.shortUrl + '</a>';
      input.value = "";  // Clear the input field
      loadUrls();        // Refresh the table to show the new URL
    });

    // Sends a DELETE request to remove a URL, then refreshes the table
    async function deleteUrl(code) {
      await fetch("/stats/" + code, { method: "DELETE" });
      loadUrls();
    }

    // Load the URL table when the page first opens
    loadUrls();
  </script>
</body>
</html>`);
});

// --- API Routes ---
// Each route is: app.METHOD(path, ...middleware, handler)
// The handler receives (req, res) — the incoming request and the outgoing response.
// Routes that use Redis are marked `async` because Redis operations return Promises.

// POST /shorten — create a short URL
// The client sends JSON like { "url": "https://example.com" } in the request body.
// `shortenLimiter` runs before the handler — if the IP has exceeded 10 requests,
// Express returns 429 and the handler function never runs.
app.post("/shorten", shortenLimiter, async (req: Request, res: Response) => {
  // Destructure: pull the `url` property out of req.body
  const { url } = req.body;

  // Validate: make sure url exists and is a string (not a number, array, etc.)
  if (!url || typeof url !== "string") {
    // 400 = Bad Request. The client sent something we can't work with.
    res.status(400).json({ error: "Missing 'url' in request body" });
    return; // Stop here — don't continue to the rest of the handler
  }

  // Normalize and validate the URL (add https:// if missing, reject garbage)
  const normalizedUrl = normalizeUrl(url.trim());

  if (!normalizedUrl) {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  // Deduplication: check if we already shortened this exact URL.
  // .get() returns one row or undefined if no match is found.
  const existing = stmts.findByUrl.get(normalizedUrl);
  if (existing) {
    // Return the existing short URL instead of creating a duplicate
    res.json({
      shortUrl: `${BASE_URL}/${existing.code}`,
      code: existing.code,
      originalUrl: normalizedUrl,
    });
    return;
  }

  // Generate a unique code. If by rare chance it collides with an existing one,
  // keep generating until we get a unique one.
  let code = generateCode();
  while (stmts.findByCode.get(code)) {
    code = generateCode();
  }

  // Insert the new URL into the database.
  // .run() executes the INSERT statement with the ? placeholders filled in.
  stmts.insert.run(code, normalizedUrl, new Date().toISOString());

  // Pre-populate the Redis cache with this new URL.
  // This way the first redirect will be a cache hit instead of a cache miss.
  await cacheSet(code, normalizedUrl);

  // 201 = Created. Return the new short URL to the client.
  res.status(201).json({
    shortUrl: `${BASE_URL}/${code}`,
    code,
    originalUrl: normalizedUrl,
  });
});

// GET /stats — list all shortened URLs and their visit counts
app.get("/stats", (_req: Request, res: Response) => {
  // .all() returns every row as an array (vs .get() which returns one row)
  // `as UrlRow[]` is a TypeScript type assertion — tells the compiler what shape the data is
  const rows = stmts.listAll.all() as UrlRow[];

  // Transform each database row (snake_case columns) into a camelCase JSON response.
  // .map() creates a new array by running a function on each element.
  const entries = rows.map((row) => ({
    shortUrl: `${BASE_URL}/${row.code}`,
    code: row.code,
    originalUrl: row.original_url,
    createdAt: row.created_at,
    visits: row.visits,
  }));
  res.json(entries);
});

// GET /stats/:code — get stats for one specific short URL
// :code is a route parameter — Express extracts it into req.params.code
// For example, GET /stats/abc123 sets req.params.code to "abc123"
app.get("/stats/:code", (req: Request<CodeParam>, res: Response) => {
  const row = stmts.findByCode.get(req.params.code);

  if (!row) {
    // 404 = Not Found. The code doesn't exist in our database.
    res.status(404).json({ error: "Short URL not found" });
    return;
  }

  res.json({
    shortUrl: `${BASE_URL}/${row.code}`,
    code: row.code,
    originalUrl: row.original_url,
    createdAt: row.created_at,
    visits: row.visits,
  });
});

// DELETE /stats/:code — delete a short URL from the database
app.delete("/stats/:code", async (req: Request<CodeParam>, res: Response) => {
  // .run() returns a result object. `changes` tells us how many rows were deleted.
  // If changes is 0, the code didn't exist — nothing was deleted.
  const result = stmts.deleteByCode.run(req.params.code);

  if (result.changes === 0) {
    res.status(404).json({ error: "Short URL not found" });
    return;
  }

  // Cache invalidation: remove the deleted URL from Redis so stale data
  // isn't served. Without this, the redirect would still work for up to 1 hour
  // (the cache TTL) even after the URL was "deleted" from SQLite.
  await cacheDel(req.params.code);

  res.json({ message: "Deleted" });
});

// GET /:code — the actual redirect (the core feature!)
// When someone visits http://localhost:3000/abc123, this handler runs.
// IMPORTANT: This route is defined LAST because /:code matches ANY path.
// If it were defined before /stats, visiting /stats would match /:code with code="stats".
//
// This is where the Redis cache shines. The flow is:
//   1. Check Redis for the URL (fast, in-memory) → cache HIT = redirect immediately
//   2. If not in Redis (cache MISS), query SQLite → store result in Redis → redirect
// This means the first visit hits SQLite, but every subsequent visit is served from Redis.
app.get("/:code", async (req: Request<CodeParam>, res: Response) => {
  const code = req.params.code;

  // Step 1: Try the Redis cache first (cache-aside pattern)
  const cachedUrl = await cacheGet(code);
  if (cachedUrl) {
    // Cache HIT — we found the URL in Redis without touching SQLite.
    // Still increment the visit counter in SQLite for analytics.
    stmts.incrementVisits.run(code);
    res.redirect(cachedUrl);
    return;
  }

  // Step 2: Cache MISS — fall back to SQLite
  const row = stmts.findByCode.get(code);

  if (!row) {
    res.status(404).json({ error: "Short URL not found" });
    return;
  }

  // Step 3: Store the result in Redis for next time (populate the cache)
  await cacheSet(code, row.original_url);

  // Increment the visit counter for analytics.
  // This runs a SQL UPDATE that adds 1 to the visits column.
  stmts.incrementVisits.run(code);

  // 302 redirect: the browser automatically navigates to the original URL.
  // The user sees the destination page, not our server.
  res.redirect(row.original_url);
});

// --- Start the server ---
// We wrap startup in an async function because connecting to Redis is asynchronous.
// Before Redis, we could just call app.listen() directly at the top level.
// Now we need to `await redis.connect()` first, which requires async/await.
async function main() {
  // Try to connect to Redis. If it fails (e.g. Redis isn't running), that's OK —
  // the app will still work using SQLite only (just without caching).
  try {
    await redis.connect();
  } catch (err) {
    console.log("Redis unavailable — running without cache (SQLite only)");
  }

  // app.listen() binds to the port and starts accepting connections.
  // The callback function runs once the server is ready.
  app.listen(PORT, () => {
    console.log(`URL Shortener running at ${BASE_URL}`);
    console.log();
    console.log("Endpoints:");
    console.log(`  POST   ${BASE_URL}/shorten       — shorten a URL`);
    console.log(`  GET    ${BASE_URL}/<code>         — redirect to original`);
    console.log(`  GET    ${BASE_URL}/stats          — list all URLs`);
    console.log(`  GET    ${BASE_URL}/stats/<code>   — stats for one URL`);
    console.log(`  DELETE ${BASE_URL}/stats/<code>   — delete a short URL`);
  });
}

// Call the async main function. .catch() handles any unexpected startup errors.
main().catch(console.error);
