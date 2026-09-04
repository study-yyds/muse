import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

let _db: NeonHttpDatabase<typeof schema> | null = null;

export function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL 未设置，请检查 server/.env');
    _db = drizzle(url, { schema });
  }
  return _db;
}

/**
 * JSONB 原子合并片段：COALESCE(col, '{}') || $patch::jsonb。
 * 用于"读-改-写"型 extra 更新的并发安全替代——两个并发写互不覆盖。
 * 仅浅合并（顶层键），符合 book_settings.extra 的语义。
 */
export function mergeJsonb(column: any, patch: Record<string, any>) {
  return sql`COALESCE(${column}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

export { schema };
