import { z } from 'zod';
import { EmbeddingProvider, Transport } from './enums.js';

const csv = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .transform((s) => [
      ...new Set(
        s
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(item).min(1));

const env = z.object({
  LANGUAGES: csv(z.string()).default(['en']), // checked against source.languages at startup
  TRANSPORTS: csv(z.enum(Transport)).default([Transport.Stdio]),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().default('file:./data/cards.db'),
  DATABASE_AUTH_TOKEN: z.string().optional(),
  EMBEDDING_MODEL: z
    .string()
    .default('compatible:bge-m3')
    .transform((s, ctx) => {
      const [provider, ...rest] = s.split(':');
      const model = rest.join(':'); // ollama tags contain ':' too, e.g. bge-m3:567m
      const p = Object.values(EmbeddingProvider).find((v) => v === provider);
      if (!p || !model) {
        ctx.addIssue({
          code: 'custom',
          message: `expected <provider>:<model>, provider one of ${Object.values(EmbeddingProvider).join(', ')}`,
        });
        return z.NEVER;
      }
      return { id: s, provider: p, model };
    }),
  EMBEDDING_BASE_URL: z.url().default('http://localhost:11434/v1'),
  EMBEDDING_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  CARD_SOURCE: z.enum(['tcgdex']).default('tcgdex'),
  UPDATE_INTERVAL_HOURS: z.coerce.number().positive().default(24),
  FULL_REFRESH_DAYS: z.coerce.number().positive().default(7),
});

export type Config = z.infer<typeof env>;

export function parseConfig(vars: NodeJS.ProcessEnv): Config {
  // compose and shells often pass empty strings for unset values
  const set = Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== ''));
  const result = env.safeParse(set);
  if (!result.success) throw new Error(`Invalid config:\n${z.prettifyError(result.error)}`);
  return result.data;
}
