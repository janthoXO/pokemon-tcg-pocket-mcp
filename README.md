# pokemon-tcg-pocket-mcp

An MCP server for searching Pokémon TCG Pocket cards. It fetches card data by itself on an
interval from [TCGdex](https://tcgdex.dev), stores it in a local database, and exposes one tool,
`search_cards`, over MCP (stdio or Streamable HTTP). It supports card text in six languages:
`en`, `fr`, `de`, `es`, `it`, `pt-br`.

> [!WARNING]
> **No HTTP auth.** Anyone who can reach the HTTP port can call `search_cards`. The server binds
> to `127.0.0.1` by default, and the Docker Compose setup maps the port to `127.0.0.1` only. Do
> not expose this port to a public network. If you need public access, put a reverse proxy with
> authentication in front of it.

> [!WARNING]
> **No database auth.** The `libsql` service in `docker-compose.yml` runs with no auth and no
> published port; only the other containers in the same Compose network can reach it. Do not
> publish its port. If you need to expose the database (for example, to point another instance at
> it from outside the Compose network), set `SQLD_AUTH_JWT_KEY` on the libsql-server and
> `DATABASE_AUTH_TOKEN` on the MCP server, and pass both as secrets (`.env` file or Docker
> secrets), never as plain command-line arguments.

> [!WARNING]
> **Single instance only.** Run one MCP server per database. The ingest lock is in-memory, not a
> database lease. Two instances pointed at the same database will both run ingest: data stays
> consistent (hashes and atomic batch writes prevent corruption), but the load on TCGdex doubles for no
> benefit.

## What it does

The server periodically fetches Pokémon TCG Pocket card data from the TCGdex API, computes hashes
to avoid redundant writes and re-embeddings, and stores everything in a libSQL database (an
embedded file or a separate libsql-server container, picked by `DATABASE_URL`). It exposes a
single MCP tool, `search_cards`, that combines exact filters (type, category, rarity, stage, set),
fuzzy name/set matching, and semantic search over card effects and attacks using text embeddings.

Card text is stored per language. Canonical values (type, stage, rarity, category) are always in
English, regardless of the requested language, so filtering works the same everywhere.

## Quickstart: Docker Compose

This is the easiest way to run everything (MCP server, libSQL database, and Ollama for local
embeddings) together.

```sh
docker compose up -d
```

This starts:

- `mcp` — the MCP server, listening on `http://127.0.0.1:3000/mcp` (see the warnings above about
  exposure).
- `libsql` — the database, only reachable from inside the Compose network.
- `ollama` plus a one-shot `ollama-pull` service that pulls the `bge-m3` embedding model before
  the MCP server needs it.

The first `ollama-pull` run downloads a roughly 1 GB model, so the first `docker compose up` will
take a while and use significant bandwidth and disk. First ingest (a few thousand cards per
language) also takes a few minutes to embed on CPU; later ingests only re-embed changed cards.

To use an embedded database file instead of the `libsql` service, remove the `libsql` service from
`docker-compose.yml`, set `DATABASE_URL: file:/data/cards.db` on `mcp`, and mount a volume at
`/data`. To use OpenAI instead of Ollama for embeddings, remove the `ollama` and `ollama-pull`
services and set `EMBEDDING_MODEL: openai:text-embedding-3-small` plus `OPENAI_API_KEY` on `mcp`.

## Quickstart: local development

```sh
pnpm install
```

You need an embedding model reachable over an OpenAI-compatible `/v1/embeddings` endpoint. The
simplest local option is [Ollama](https://ollama.com):

```sh
ollama pull bge-m3
```

Then run the server directly from source, restarting automatically on file changes:

```sh
pnpm dev
```

By default this uses `LANGUAGES=en`, `TRANSPORTS=stdio`, an embedded database at
`file:./data/cards.db`, and `EMBEDDING_MODEL=compatible:bge-m3` against
`http://localhost:11434/v1` (Ollama's default). Override any of these with environment variables,
for example:

```sh
LANGUAGES=en,de,fr TRANSPORTS=stdio,http pnpm dev
```

## Configuration

All configuration is via environment variables; there are no CLI flags. List-valued variables are
comma-separated.

| Variable                               | Default / example                                      | Meaning                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LANGUAGES`                            | `en` / `en,de,fr`                                      | Languages to ingest and serve. Each must be supported by the card source, or startup fails.                                                                                              |
| `TRANSPORTS`                           | `stdio` / `stdio,http`                                 | Transports to start. Values: `stdio`, `http`. Both can run at once, in one process.                                                                                                      |
| `PORT`                                 | `3000`                                                 | HTTP port. Used when `TRANSPORTS` includes `http`.                                                                                                                                       |
| `HOST`                                 | `127.0.0.1`                                            | HTTP bind address. The Docker image sets this to `0.0.0.0` internally.                                                                                                                   |
| `DATABASE_URL`                         | `file:./data/cards.db` (default), `http://libsql:8080` | Database location. `file:` is an embedded SQLite-compatible file. `http(s):`/`libsql:` is a libsql-server (or Turso cloud) URL. The Docker image defaults this to `file:/data/cards.db`. |
| `DATABASE_AUTH_TOKEN`                  | `eyJ...`                                               | JWT for a libsql-server with auth enabled. Leave unset for no auth.                                                                                                                      |
| `EMBEDDING_MODEL`                      | `openai:text-embedding-3-small`, `compatible:bge-m3`   | `<provider>:<model>`. Provider is `openai` or `compatible`.                                                                                                                              |
| `EMBEDDING_BASE_URL`                   | `http://ollama:11434/v1`                               | Used with the `compatible` provider. Ollama, LM Studio, vLLM, and llama.cpp all serve an OpenAI-style `/v1/embeddings` endpoint.                                                         |
| `EMBEDDING_API_KEY` / `OPENAI_API_KEY` | `sk-...`                                               | API key, if the provider needs one.                                                                                                                                                      |
| `CARD_SOURCE`                          | `tcgdex`                                               | Which card data source to use.                                                                                                                                                           |
| `UPDATE_INTERVAL_HOURS`                | `24`                                                   | How often ingest runs.                                                                                                                                                                   |
| `FULL_REFRESH_DAYS`                    | `7`                                                    | How often ingest ignores set fingerprints and re-checks every card, to catch errata.                                                                                                     |

`DATABASE_URL` defaults to `file:./data/cards.db` when running locally. The Docker image overrides
this default to `file:/data/cards.db`, matching the `/data` volume set up in the Dockerfile.

## Connecting an MCP client

### stdio

For clients that launch the server as a subprocess (Claude Desktop, Claude Code, and similar),
point `command` at `node` and `args` at the built entry point. Run `pnpm build` first so
`dist/index.js` exists.

```json
{
  "mcpServers": {
    "pokemon-tcg-pocket": {
      "command": "node",
      "args": ["/path/to/pokemon-tcg-pocket-mcp/dist/index.js"],
      "env": {
        "LANGUAGES": "en,de,fr",
        "TRANSPORTS": "stdio",
        "DATABASE_URL": "file:/path/to/pokemon-tcg-pocket-mcp/data/cards.db",
        "EMBEDDING_MODEL": "compatible:bge-m3",
        "EMBEDDING_BASE_URL": "http://localhost:11434/v1"
      }
    }
  }
}
```

### HTTP

When the server is already running with `TRANSPORTS` including `http` (for example, via
`docker compose up`), point the client at the `/mcp` endpoint instead of launching a subprocess:

```
http://127.0.0.1:3000/mcp
```

With the Claude Code CLI:

```sh
claude mcp add --transport http pokemon-tcg-pocket http://127.0.0.1:3000/mcp
```

Remember the warning above: this endpoint has no authentication, so only expose it on a trusted
network, or put an authenticating reverse proxy in front of it.

## The `search_cards` tool

All fields are optional except `language`; an omitted or `null` field matches everything.

- `language` (required) — one of the configured `LANGUAGES` values.
- `name` — fuzzy match against the localized card name.
- `type` — exact match on Pokémon energy type.
- `category` — exact match (`Pokemon`, `Item`, `Supporter`, `Tool`, `Stadium`).
- `rarity` — exact match on rarity.
- `stage` — exact match on evolution stage (`Basic`, `Stage1`, `Stage2`, or the equivalent number).
- `set` — a set id (`A1`) matched exactly, or a set name matched fuzzily.
- `effect` — semantic search over ability/trainer effect text.
- `attack` — semantic search over attack name, cost, and effect text.
- `limit` — maximum number of results (1-50, default 10).

Results carry a `score` (0-1) only when `name`, `effect` or `attack` is given; otherwise they are
ordered by card id.

Enum values (type, stage, rarity, category, attack cost) are always the canonical English values,
even when card text is in another language.

## Language fallback

If a card does not exist in the requested language (TCGdex is missing a few sets in `de`, `es`,
`it`, and `pt-br`), the server falls back to the English text for that card instead of omitting
it. Such results carry a `"fallbackLanguage": "en"` field; results that exist natively in the
requested language do not have this field. Set names fall back the same way. English text is
always ingested and embedded, even if `LANGUAGES` excludes `en`, so that fallback results have
usable text and vectors.

## Choosing an embedding model

`effect` and `attack` search rank results using text embeddings, so the embedding model matters
for search quality. If you configure any language other than `en`, you need a **multilingual**
embedding model, since queries and card text can be in different languages, or your language of
choice can fall back to English text. Good options: `bge-m3` (served locally via Ollama, the
Compose default) or `text-embedding-3-small` (OpenAI). Avoid English-only models such as
`nomic-embed-text` if you serve any non-English language.

Changing `EMBEDDING_MODEL` is safe: the server detects the change at startup, clears stored
vectors, and re-embeds all card text automatically on the next ingest run. No manual migration is
needed.

## Development commands

| Command                             | Does                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `pnpm build`                        | Compile `src/` to `dist/`.                                                |
| `pnpm start`                        | Run the compiled server (`node dist/index.js`).                           |
| `pnpm dev`                          | Run TypeScript directly with `tsx`, restarting on file changes.           |
| `pnpm typecheck`                    | Report type errors without emitting output.                               |
| `pnpm lint` / `pnpm lint:fix`       | Run ESLint / run ESLint with autofix.                                     |
| `pnpm format` / `pnpm format:check` | Run Prettier to write formatting / check formatting (used in CI).         |
| `pnpm test`                         | Run tests (`node:test` via `tsx`).                                        |
| `pnpm db:generate`                  | Generate a SQL migration in `drizzle/` from a schema change.              |
| `pnpm db:migrate`                   | Apply pending migrations to `DATABASE_URL` without starting the server.   |
| `pnpm check`                        | Run all checks above (typecheck, lint, format check, test). CI runs this. |
