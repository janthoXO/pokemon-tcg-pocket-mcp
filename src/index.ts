import { createServer as createHttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { parseConfig } from './config.js';
import { openDb, type Db } from './db/client.js';
import { getMeta } from './db/store.js';
import { createEmbed, type Embed } from './embed.js';
import { Transport } from './enums.js';
import { startScheduler } from './ingest.js';
import { search, searchInput } from './search.js';
import { tcgdex } from './sources/tcgdex.js';
import type { CardSource } from './sources/types.js';

const sources: Record<string, CardSource> = { tcgdex };

function createMcpServer(db: Db, embed: Embed, languages: [string, ...string[]]) {
  const server = new McpServer({ name: 'pokemon-tcg-pocket', version: '1.0.0' });
  server.registerTool(
    'search_cards',
    {
      title: 'Search Pokémon TCG Pocket cards',
      description:
        'Search Pokémon TCG Pocket cards. All fields except `language` are optional; omitted or null fields match everything. Enum fields filter exactly, `name` and `set` filter fuzzily, `effect` and `attack` rank by meaning. Enum values are English in every language. Results with `fallbackLanguage` exist only in that language.',
      inputSchema: searchInput(languages),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const result = await search(db, embed, input);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );
  return server;
}

async function main() {
  const config = parseConfig(process.env);
  const source = sources[config.CARD_SOURCE];
  if (!source) throw new Error(`Unknown CARD_SOURCE ${config.CARD_SOURCE}`);
  const unsupported = config.LANGUAGES.filter((l) => !source.languages.includes(l));
  if (unsupported.length) {
    throw new Error(
      `LANGUAGES not supported by ${source.id}: ${unsupported.join(', ')}. Supported: ${source.languages.join(', ')}`,
    );
  }
  const languages = config.LANGUAGES as [string, ...string[]]; // csv() guarantees min 1

  const db = await openDb(config.DATABASE_URL, config.DATABASE_AUTH_TOKEN);
  const embed = createEmbed(config);
  const scheduler = startScheduler({
    db,
    source,
    embed,
    languages,
    embeddingModel: config.EMBEDDING_MODEL.id,
    intervalHours: config.UPDATE_INTERVAL_HOURS,
    fullRefreshDays: config.FULL_REFRESH_DAYS,
  });

  if (config.TRANSPORTS.includes(Transport.Stdio)) {
    await createMcpServer(db, embed, languages).connect(new StdioServerTransport());
    console.error('stdio transport ready');
  }

  const http = config.TRANSPORTS.includes(Transport.Http)
    ? createHttpServer((req, res) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (req.method === 'GET' && path === '/healthz') {
          getMeta(db).then(
            () => res.writeHead(200).end('ok'),
            () => res.writeHead(503).end('db unreachable'),
          );
          return;
        }
        if (path !== '/mcp') {
          res.writeHead(404).end();
          return;
        }
        // stateless: fresh server + transport per request
        const server = createMcpServer(db, embed, languages);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        server
          .connect(transport)
          .then(() => transport.handleRequest(req, res))
          .catch((err: unknown) => {
            console.error('http request failed:', err);
            if (!res.headersSent) res.writeHead(500).end();
          });
      }).listen(config.PORT, config.HOST, () => {
        console.error(`http transport ready on http://${config.HOST}:${config.PORT}/mcp`);
      })
    : undefined;

  const shutdown = () => {
    scheduler.stop();
    http?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
