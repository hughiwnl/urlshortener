# Stage 1: Build
# Install all dependencies (including dev) and compile TypeScript
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: Production
# Only install production dependencies and copy compiled JS
FROM node:20-slim AS production

# better-sqlite3 needs these native libraries to run
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# The database file will be created here at runtime
VOLUME /app/data
ENV DB_PATH=/app/data/urls.db

EXPOSE 3000
CMD ["node", "dist/index.js"]
