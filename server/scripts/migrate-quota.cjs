/**
 * 计费字段迁移（手动执行一次）：
 * 1. users.monthly_words_quota：月度 AI 字数额度，默认免费 3 万字（-1 无限）
 * 2. user_monthly_quota.used_words：本月已用字数（对外计费口径=生成字数）
 * 3. book_limit 默认改为 -1（免费不限作品数），存量 3 本限制的用户放开
 * 用法：cd server && node scripts/migrate-quota.cjs
 */
const fs = require('fs');
const path = require('path');
const { drizzle } = require('drizzle-orm/neon-http');
const { sql } = require('drizzle-orm');

const envRaw = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const url = (envRaw.match(/^DATABASE_URL=(.+)$/m) || [])[1]?.trim();
if (!url) {
  console.error('DATABASE_URL not found in server/.env');
  process.exit(1);
}

const db = drizzle(url);

(async () => {
  const statements = [
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_words_quota integer NOT NULL DEFAULT 30000`,
    sql`ALTER TABLE user_monthly_quota ADD COLUMN IF NOT EXISTS used_words integer NOT NULL DEFAULT 0`,
    sql`ALTER TABLE users ALTER COLUMN book_limit SET DEFAULT -1`,
    sql`UPDATE users SET book_limit = -1 WHERE book_limit = 3`,
  ];
  for (const st of statements) {
    await db.execute(st);
    console.log('OK');
  }
  console.log('migration done');
})().catch((e) => {
  console.error('migration failed:', e.message);
  process.exit(1);
});
