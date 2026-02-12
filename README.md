# URL Shortener

A URL shortener that runs locally. I built this to learn TypeScript, Express, SQLite, Redis, and Docker.

You paste in a long URL, it gives you a short one. When someone visits the short URL, they get redirected to the original.

## Tech stack

- **TypeScript** 
- **Express**  
- **SQLite** - stores URLs on disk as a single file
- **Redis** - in-memory cache making redirects faster
- **Docker** - packages everything into containers so it runs the same on any machine

## How to run

### Locally (without Docker)

```bash
npm install
npm run build
npm start
```

Then open http://localhost:3000

Redis is optional. If it's not running, the app just skips caching and uses SQLite directly.

### With Docker Compose (app + Redis)

```bash
docker compose up
```

This starts both the app and Redis. Open http://localhost:3000.

## API endpoints

| Method | Endpoint | What it does |
|--------|----------|-------------|
| `POST` | `/shorten` | Shorten a URL. Body: `{"url": "https://example.com"}` |
| `GET` | `/:code` | Redirects to the original URL |
| `GET` | `/stats` | List all URLs with visit counts |
| `GET` | `/stats/:code` | Get stats for one URL |
| `DELETE` | `/stats/:code` | Delete a short URL |

### Example

```bash
# Shorten a URL
curl -X POST http://localhost:3000/shorten \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com"}'

# Response:
# {"shortUrl":"http://localhost:3000/abc123","code":"abc123","originalUrl":"https://github.com/"}
```

## Architecture

```
Browser/curl
     |
     v
  Express (handles HTTP requests)
     |
     |--- POST /shorten ---> validate URL ---> save to SQLite ---> cache in Redis
     |
     |--- GET /:code ------> check Redis cache ---> (miss?) query SQLite ---> redirect
     |
     |--- DELETE /:code ---> delete from SQLite ---> remove from Redis cache
```

## Trade-offs and why I made them

### Why SQLite instead of PostgreSQL?

SQLite stores everything in a single file. No separate database server to install, no passwords to configure, no connection strings. You just point it at a file path and it works.

PostgreSQL is better when you need multiple servers connecting to the same database, but for a single-server app like this, SQLite is simpler and actually faster (no network round-trip to a separate process).

I started with a JSON file, moved to SQLite when the JSON approach couldn't handle concurrent requests, and would move to PostgreSQL if I ever needed multiple app servers.

### Why Redis instead of just using SQLite for everything?

Redis stores data in memory (RAM), which is way faster than reading from disk. The redirect endpoint (`GET /:code`) gets hit the most, so caching those lookups in Redis means most redirects never touch SQLite at all.

The trade-off is complexity. Now I have two data stores to manage and I need to keep them in sync (cache invalidation). For a learning project this is worth it because caching is something you need to understand for real-world apps.

The app also works fine without Redis. If Redis goes down, it just falls back to SQLite. The cache is a performance optimization, not a requirement.


### Why random codes instead of sequential IDs?

Random codes (like `abc123`) don't reveal how many URLs have been created. If I used sequential IDs (1, 2, 3...), anyone could guess that `localhost:3000/500` exists and try to find all URLs by counting up. Random codes are harder to guess.

The trade-off is a small chance of collision (two codes being the same), but with 6 characters from a 64-character alphabet, there are ~2 billion possible codes, so collisions are extremely rare. The code retries if one happens.

### Why Docker?

Without Docker, someone cloning this repo needs the right version of Node.js, needs to run `npm install` (which might fail on their OS because of `better-sqlite3`'s native compilation), and needs Redis installed separately.

With Docker, it's just `docker compose up`. Everything runs in containers with the exact same environment regardless of what OS you're on.

## What I learned

- How Express handles HTTP requests with middleware and route handlers
- How SQL databases work (tables, primary keys, prepared statements, WAL mode)
- The cache-aside pattern (check cache first, fall back to database, populate cache on miss)
- How Docker packages apps into containers and Docker Compose runs multiple services together
- Why you should always validate user input at the boundary where it enters your system
- How rate limiting works as middleware that runs before your route handlers
- The progression from JSON file to SQLite to PostgreSQL (and when each one makes sense)
