import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import Database from "better-sqlite3";
import path from "path";

// --- Config ---

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = path.join(__dirname, "..", "urls.db");

// --- Types ---

// A row from the urls table
interface UrlRow {
  code: string;
  original_url: string;
  created_at: string;
  visits: number;
}

// Route params for /:code routes
interface CodeParam {
  code: string;
}

// --- Database setup (SQLite) ---

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS urls (
    code        TEXT PRIMARY KEY,
    original_url TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    visits      INTEGER NOT NULL DEFAULT 0
  )
`);

// Prepare statements once for performance
const stmts = {
  findByUrl:    db.prepare<[string], UrlRow>("SELECT * FROM urls WHERE original_url = ?"),
  findByCode:   db.prepare<[string], UrlRow>("SELECT * FROM urls WHERE code = ?"),
  insert:       db.prepare("INSERT INTO urls (code, original_url, created_at, visits) VALUES (?, ?, ?, 0)"),
  listAll:      db.prepare("SELECT * FROM urls"),
  deleteByCode: db.prepare("DELETE FROM urls WHERE code = ?"),
  incrementVisits: db.prepare("UPDATE urls SET visits = visits + 1 WHERE code = ?"),
};

// --- Core logic ---

// Generate a short random code (6 chars from a URL-safe alphabet)
function generateCode(): string {
  return crypto.randomBytes(4).toString("base64url").slice(0, 6);
}

// Normalize and validate a URL. Returns the valid URL or null if invalid.
function normalizeUrl(url: string): string | null {
  // Add protocol if missing
  const withProtocol = /^https?:\/\//i.test(url) ? url : `https://${url}`;

  try {
    const parsed = new URL(withProtocol);
    // Only allow http/https (blocks javascript:, data:, etc.)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

// --- Server ---

const app = express();
app.use(express.json());

// Rate limiting: 100 requests per 15 minutes per IP (global)
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests, try again later" },
}));

// Stricter limit for creating short URLs: 10 per 15 minutes per IP
const shortenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many URLs shortened, try again later" },
});

// GET / — serve the web UI
app.get("/", (_req: Request, res: Response) => {
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
    const form = document.getElementById("shorten-form");
    const input = document.getElementById("url-input");
    const result = document.getElementById("result");
    const urlList = document.getElementById("url-list");

    async function loadUrls() {
      const res = await fetch("/stats");
      const urls = await res.json();
      if (urls.length === 0) {
        urlList.innerHTML = '<tr><td colspan="4" class="empty">No URLs yet. Shorten one above!</td></tr>';
        return;
      }
      urlList.innerHTML = urls.map(u =>
        '<tr>' +
          '<td><a href="' + u.shortUrl + '" target="_blank">' + u.code + '</a></td>' +
          '<td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + u.originalUrl + '</td>' +
          '<td class="visits">' + u.visits + '</td>' +
          '<td><button class="delete-btn" onclick="deleteUrl(\\''+u.code+'\\')">delete</button></td>' +
        '</tr>'
      ).join("");
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const res = await fetch("/shorten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: input.value })
      });
      const data = await res.json();
      result.style.display = "block";
      result.innerHTML = 'Shortened: <a href="' + data.shortUrl + '" target="_blank">' + data.shortUrl + '</a>';
      input.value = "";
      loadUrls();
    });

    async function deleteUrl(code) {
      await fetch("/stats/" + code, { method: "DELETE" });
      loadUrls();
    }

    loadUrls();
  </script>
</body>
</html>`);
});

// POST /shorten — create a short URL
// Body: { "url": "https://example.com" }
app.post("/shorten", shortenLimiter, (req: Request, res: Response) => {
  const { url } = req.body;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing 'url' in request body" });
    return;
  }

  const normalizedUrl = normalizeUrl(url.trim());

  if (!normalizedUrl) {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  // Check if this URL was already shortened
  const existing = stmts.findByUrl.get(normalizedUrl);
  if (existing) {
    res.json({
      shortUrl: `${BASE_URL}/${existing.code}`,
      code: existing.code,
      originalUrl: normalizedUrl,
    });
    return;
  }

  // Generate a unique code (retry if collision)
  let code = generateCode();
  while (stmts.findByCode.get(code)) {
    code = generateCode();
  }

  stmts.insert.run(code, normalizedUrl, new Date().toISOString());

  res.status(201).json({
    shortUrl: `${BASE_URL}/${code}`,
    code,
    originalUrl: normalizedUrl,
  });
});

// GET /stats — list all shortened URLs and their stats
app.get("/stats", (_req: Request, res: Response) => {
  const rows = stmts.listAll.all() as UrlRow[];
  const entries = rows.map((row) => ({
    shortUrl: `${BASE_URL}/${row.code}`,
    code: row.code,
    originalUrl: row.original_url,
    createdAt: row.created_at,
    visits: row.visits,
  }));
  res.json(entries);
});

// GET /stats/:code — get stats for a specific short URL
app.get("/stats/:code", (req: Request<CodeParam>, res: Response) => {
  const row = stmts.findByCode.get(req.params.code);

  if (!row) {
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

// DELETE /stats/:code — delete a short URL
app.delete("/stats/:code", (req: Request<CodeParam>, res: Response) => {
  const result = stmts.deleteByCode.run(req.params.code);

  if (result.changes === 0) {
    res.status(404).json({ error: "Short URL not found" });
    return;
  }

  res.json({ message: "Deleted" });
});

// GET /:code — redirect to the original URL
app.get("/:code", (req: Request<CodeParam>, res: Response) => {
  const row = stmts.findByCode.get(req.params.code);

  if (!row) {
    res.status(404).json({ error: "Short URL not found" });
    return;
  }

  // Track the visit
  stmts.incrementVisits.run(req.params.code);

  res.redirect(row.original_url);
});

// --- Start ---

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
