/**
 * 管理员审计日志表迁移（手动执行一次）
 * 用法：cd server && node scripts/migrate-admin-audit.cjs
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
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      operator_id uuid NOT NULL REFERENCES users(user_id) ON DELETE SET NULL,
      target_user_id uuid REFERENCES users(user_id) ON DELETE SET NULL,
      action varchar(40) NOT NULL,
      detail jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  console.log('OK: table created');
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_aal_created ON admin_audit_logs (created_at)
  `);
  console.log('OK: index created');
  console.log('migration done');
})().catch((e) => {
  console.error('migration failed:', e.message);
  process.exit(1);
});
