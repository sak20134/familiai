import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: '../../packages/core/src/db/schema.ts',
  out: './drizzle',
});
