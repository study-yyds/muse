# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Muse is a full-stack AI writing assistant for novelists. Monorepo with pnpm workspaces.

```
muse/
├── client/          # React 19 + Vite + Tailwind CSS
├── server/          # NestJS + Drizzle ORM + PostgreSQL (Neon)
└── shared/          # TypeScript types shared between client/server
```

**Key dependencies**: TanStack Query (data fetching), TipTap (rich text editor), Zustand (state), d3-force (graph layout), JSZip (EPUB export), pnpm (package manager).

## Common Commands

```bash
pnpm dev                # Start both client (:3000) and server (:3004)
pnpm dev:client         # Client only
pnpm dev:server         # Server only via nest start --watch

# Server - if nest start --watch fails (tsbuildinfo cache issue):
cd server && rm -f tsconfig.build.tsbuildinfo && npx tsc --project tsconfig.build.json && node dist/main.js

# Testing
pnpm test                          # All tests
cd client && npx vitest --run      # Client tests only
cd server && npx jest --passWithNoTests  # Server tests only
cd server && npx jest --testPathPatterns="ai.service"  # Single test file

# Type checking
pnpm typecheck
cd client && npx tsc --noEmit
cd server && npx tsc --noEmit

# Linting
pnpm lint
cd server && npx prettier --write src/ai/ai.service.ts  # Fix formatting

# Database (Drizzle + Neon)
pnpm db:generate    # Generate migrations from schema changes
pnpm db:migrate     # Apply migrations
```

## Architecture

### Backend (NestJS)

**Module structure** under `server/src/`:
- `ai/` — AI service (core: prompts, API calls, streaming), controller (endpoints)
- `auth/` — JWT guard, phone verification, API key CRUD + AES-256-GCM encryption
- `books/` — CRUD, soft delete, word count sync, book-owner guard
- `chapters/` — Save/merge/split with auto `#recalcBookWords`
- `characters/` — CRUD with field whitelisting
- `world/`, `outline/`, `export/`, `templates/`, `char-test/`, `admin/`

**Database**: Drizzle ORM with Neon PostgreSQL. Schema in `server/src/database/schema/`. `getDb()` from `database/connection.ts` returns a singleton Neon HTTP connection.

**AI Key resolution** (`ai.service.ts` `resolveApiKey`): Priority order — 1) user's custom API key from `user_api_keys` table (decrypted), 2) platform env var. Routes Qwen models (`qwen*`) to `QWEN_API_KEY`, image models to `VOLCANO_IMAGE_KEY` or Qwen image URL. AIService can be instantiated directly in tests (no NestJS DI needed for `resolveApiKey`).

**Streaming**: SSE via `text/event-stream`. Custom events: `chunk`, `reasoning`, `step`, `done`, `error`. Chat uses `streamChatToClient`, quick-create sends progress `step` events.

### Frontend (React + Vite)

**Pages**: `BookListPage` (home), `BookDetailPage` (main workspace), `LoginPage`, `AdminPage`.

**BookDetailPage tabs**: write, outline, characters, world, stats, settings. For `type: "short"` books, only write + settings are shown.

**Key components**:
- `WritingEditor` → wraps `TiptapEditor` (TipTap rich text)
- `BookSettingsPanel` — cover generation (model/size/ratio selector + history), visual style, synopsis, mimic style
- `CharacterList` — character cards with portrait generation (model/size selector + history)
- `ModelSelector` — unified model dropdown (platform built-in + user custom keys, grouped)
- `ApiKeyManager` — global API key CRUD (Settings menu in header)

**State**: Zustand for editor state, TanStack Query for server data, React Router for navigation.

### Shared types (`shared/src/index.ts`)

Single file with all DTOs: `BookListItem`, `CharacterData`, `ChapterDetail`, etc. Import as `@muse/shared`.

## Key Patterns

- **Server restarts**: `nest start --watch` uses incremental compilation. If changes aren't picked up, delete `server/tsconfig.build.tsbuildinfo` and rebuild.
- **Database migrations**: Schema changes in Drizzle files need manual `ALTER TABLE` via `node -e "..."` scripts (no automated migration runner configured).
- **API response format**: `{ code: number, data?: T, message?: string }`.
- **Writing editor content**: Plain text with `\n` between paragraphs. `TiptapEditor` converts to `<p>` tags on load. `getText()` returns `\n`-separated text.
- **.env loading**: `@nestjs/config` loads from cwd. Server must be started from `server/` directory.
- **Server port**: `server/.env` sets `PORT=3004`. Vite proxies `/api` and `/uploads` to `http://localhost:3004`. Default in `main.ts` is 3001 — the `.env` override is critical.
- **Commit convention**: `type: description` (English, lowercase, ≤72 chars). Must go through `git-save` skill (`.claude/settings.json` denies direct `git commit`). Never push unless asked.
- **Bilingual convention**: Chinese comments, UI text, and communication. English for code identifiers, commit messages, and file paths.
- **Client linting**: Uses **oxlint**, not eslint. Server uses eslint + prettier.
- **Two lockfiles**: `pnpm-lock.yaml` is canonical. `package-lock.json` is a stale npm artifact — ignore it.
- **.claude/** is gitignored: contains skills (git-save, testing, design-system) and hooks. Not committed.
- **.env keys**: `AI_PLATFORM_KEY`, `VOLCANO_IMAGE_KEY`, `QWEN_API_KEY`, `QWEN_BASE_URL`, `QWEN_IMAGE_URL`, `ENCRYPTION_KEY` (32-byte hex). User API keys stored encrypted in `user_api_keys` table.
