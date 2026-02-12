# --- Stage 1: Build ---
# A Dockerfile has "stages". Each FROM starts a new stage with a fresh filesystem.
# "node:20-slim" is a pre-built image with Node.js 20 installed on a minimal Debian Linux.
# "AS build" names this stage so we can reference it later with COPY --from=build.
FROM node:20-slim AS build

# Set the working directory inside the container. All commands below run from /app.
# This is like doing `cd /app` — if it doesn't exist, Docker creates it.
WORKDIR /app

# Copy package.json and package-lock.json FIRST (before source code).
# Docker caches each step as a "layer". If these files haven't changed,
# Docker skips the npm install on the next build — massive time savings.
COPY package*.json ./

# `npm ci` is like `npm install` but stricter:
# - It uses the exact versions from package-lock.json (reproducible builds)
# - It's faster because it skips some resolution steps
RUN npm ci

# Now copy the rest of the source code and compile TypeScript.
# We copy these AFTER npm ci so changing source code doesn't re-trigger npm install.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Stage 2: Production ---
# Start fresh from the same base image. The build stage's node_modules (with devDependencies
# like TypeScript) are thrown away — only the compiled JS is carried over.
FROM node:20-slim AS production

# better-sqlite3 is a native Node module (compiled C++). It needs these build tools
# to compile during npm install. We clean up the apt cache after to keep the image small.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install ONLY production dependencies (--omit=dev skips devDependencies like TypeScript)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the compiled JavaScript from the build stage.
# This is the key benefit of multi-stage builds: we get the compiled output
# without carrying over all the build tools and devDependencies.
COPY --from=build /app/dist ./dist

# VOLUME declares that /app/data should be stored outside the container.
# Without a volume, data is lost when the container is removed.
# With a volume, the database file persists across container restarts.
VOLUME /app/data

# ENV sets an environment variable inside the container.
# Our app reads process.env.DB_PATH to know where to put the database.
ENV DB_PATH=/app/data/urls.db

# EXPOSE documents that this container listens on port 3000.
# It doesn't actually open the port — you still need -p 3000:3000 when running.
EXPOSE 3000

# CMD is the command that runs when the container starts.
# The array format ["node", "dist/index.js"] is preferred over a string
# because it runs the process directly (no shell wrapper).
CMD ["node", "dist/index.js"]
