import express, { Request, Response } from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// --- Config ---

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = path.join(__dirname, "..", "urls.json");

// --- Types ---

// Each shortened URL maps a short code to an original URL + metadata
interface UrlEntry {
  originalUrl: string;
  createdAt: string;
  visits: number;
}

// The "database" is just a Record of code -> entry
type UrlDatabase = Record<string, UrlEntry>;

// Route params for /:code routes
interface CodeParam {
  code: string;
}

// --- Database helpers (JSON file on disk) ---

function loadDb(): UrlDatabase {
  if (!fs.existsSync(DB_PATH)) return {};
  const raw = fs.readFileSync(DB_PATH, "utf-8");
  return JSON.parse(raw);
}

function saveDb(db: UrlDatabase): void {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// --- Core logic ---

// Generate a short random code (6 chars from a URL-safe alphabet)
function generateCode(): string {
  return crypto.randomBytes(4).toString("base64url").slice(0, 6);
}

// Make sure the URL has a protocol so redirects work
function normalizeUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) {
    return `https://${url}`;
  }
  return url;
}

// --- Server ---

const app = express();
app.use(express.json());

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
app.post("/shorten", (req: Request, res: Response) => {
  const { url } = req.body;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing 'url' in request body" });
    return;
  }

  const normalizedUrl = normalizeUrl(url.trim());
  const db = loadDb();

  // Check if this URL was already shortened
  const existing = Object.entries(db).find(
    ([, entry]) => entry.originalUrl === normalizedUrl
  );
  if (existing) {
    res.json({
      shortUrl: `${BASE_URL}/${existing[0]}`,
      code: existing[0],
      originalUrl: normalizedUrl,
    });
    return;
  }

  // Generate a unique code
  let code = generateCode();
  while (db[code]) {
    code = generateCode();
  }

  db[code] = {
    originalUrl: normalizedUrl,
    createdAt: new Date().toISOString(),
    visits: 0,
  };
  saveDb(db);

  res.status(201).json({
    shortUrl: `${BASE_URL}/${code}`,
    code,
    originalUrl: normalizedUrl,
  });
});

// GET /stats — list all shortened URLs and their stats
app.get("/stats", (_req: Request, res: Response) => {
  const db = loadDb();
  const entries = Object.entries(db).map(([code, entry]) => ({
    shortUrl: `${BASE_URL}/${code}`,
    code,
    ...entry,
  }));
  res.json(entries);
});

// GET /stats/:code — get stats for a specific short URL
app.get("/stats/:code", (req: Request<CodeParam>, res: Response) => {
  const db = loadDb();
  const entry = db[req.params.code];

  if (!entry) {
    res.status(404).json({ error: "Short URL not found" });
    return;
  }

  res.json({
    shortUrl: `${BASE_URL}/${req.params.code}`,
    code: req.params.code,
    ...entry,
  });
});

// DELETE /stats/:code — delete a short URL
app.delete("/stats/:code", (req: Request<CodeParam>, res: Response) => {
  const db = loadDb();

  if (!db[req.params.code]) {
    res.status(404).json({ error: "Short URL not found" });
    return;
  }

  delete db[req.params.code];
  saveDb(db);
  res.json({ message: "Deleted" });
});

// GET /:code — redirect to the original URL
app.get("/:code", (req: Request<CodeParam>, res: Response) => {
  const db = loadDb();
  const entry = db[req.params.code];

  if (!entry) {
    res.status(404).json({ error: "Short URL not found" });
    return;
  }

  // Track the visit
  entry.visits++;
  saveDb(db);

  res.redirect(entry.originalUrl);
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
