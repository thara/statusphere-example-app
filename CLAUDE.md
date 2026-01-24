# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is an AT Protocol example application called "Statusphere" that demonstrates:
- OAuth-based authentication with AT Protocol servers
- Fetching user profiles from the network
- Listening to the AT Protocol firehose for real-time data
- Publishing custom records using the `xyz.statusphere.status` schema

See https://atproto.com/guides/applications for the companion guide.

## Development Commands

```bash
# Install dependencies
npm install

# Development (with auto-reload and pretty logging)
npm run dev

# Build for production
npm run build

# Run production build
npm start

# Generate TypeScript types from Lexicon schemas
npm run lexgen

# Clean build artifacts
npm clean
```

## Environment Setup

Copy `.env.template` to `.env` for local development. The template includes sensible defaults for development (in-memory database, test secrets).

For production deployment, generate secrets:
```bash
# Generate COOKIE_SECRET
openssl rand -base64 33

# Generate PRIVATE_KEYS (requires npm install first)
./bin/gen-jwk
```

Set `PUBLIC_URL` to your deployed URL (e.g., `https://myapp.com`) - this is required for confidential OAuth clients and informs the client ID.

## Architecture

### Core Components

**Application Context** (`src/context.ts`):
- Central state container created at startup
- Manages lifecycle of database, OAuth client, firehose ingester, logger, and ID resolver
- Passed to all routes via `createRouter(ctx)`

**OAuth Flow** (`src/auth/`):
- Uses `@atproto/oauth-client-node` for AT Protocol OAuth
- Confidential client in production (requires `PRIVATE_KEYS` and `PUBLIC_URL`)
- Loopback client in development
- Session state stored in SQLite (`auth_session`, `auth_state` tables)
- User sessions managed via `iron-session` cookies (signed with `COOKIE_SECRET`)

**Firehose Ingester** (`src/ingester.ts`):
- Subscribes to AT Protocol firehose for `xyz.statusphere.status` records
- Handles create/update/delete events in real-time
- Updates local SQLite cache automatically
- Runs continuously after server starts

**Database** (`src/db.ts`):
- SQLite with Kysely query builder
- Four tables: `status`, `profile`, `auth_session`, `auth_state`
- Migrations defined inline in `src/db.ts`
- Schema auto-migrates on startup via `migrateToLatest()`

**Routes** (`src/routes.ts`):
- Express-based HTTP router
- OAuth endpoints: `/login`, `/logout`, `/oauth/callback`, `/signup`
- OAuth metadata: `/oauth-client-metadata.json`, `/.well-known/jwks.json`
- Main page: `/` (shows status feed, supports posting if logged in)
- Status posting: `POST /status`
- `getSessionAgent()` helper retrieves authenticated AT Protocol agent from session cookie

### Data Flow

1. **User Login**: User submits handle/DID → OAuth flow initiated → callback stores session → agent created for authenticated requests
2. **Status Publishing**: User posts status → validated against Lexicon → written to user's AT Protocol repo → optimistically cached in local SQLite → user's profile fetched and cached
3. **Status Ingestion**: Firehose emits event → ingester validates record → updates SQLite → appears on homepage
4. **Profile Display**: Homepage JOINs status with cached profiles → displays "DisplayName (@handle)" format

### Lexicon System

Custom schemas in `lexicons/*.json` define AT Protocol record types. Run `npm run lexgen` to generate TypeScript types in `src/lexicon/types/`. The app uses `xyz.statusphere.status` for user status records.

### Path Aliases

TypeScript uses `#/*` path alias mapped to `src/*` (configured in `tsconfig.json`). Import from project root like `import { AppContext } from '#/context'`.

## Key Files

- `src/index.ts` - Application entry point, orchestrates startup/shutdown
- `src/context.ts` - Application state and dependency injection
- `src/routes.ts` - HTTP routes and OAuth handlers
- `src/ingester.ts` - Firehose subscriber for real-time events
- `src/db.ts` - Database schema and migrations
- `src/auth/client.ts` - OAuth client configuration
- `src/env.ts` - Environment variable validation
