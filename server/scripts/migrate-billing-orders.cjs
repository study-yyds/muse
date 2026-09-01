/**
 * 账单订单表迁移（手动执行一次）
 * 用法：cd server && node scripts/migrate-billing-orders.cjs
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
    CREATE TABLE IF NOT EXISTS billing_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      plan_id varchar(20) NOT NULL,
      amount varchar(20) NOT NULL,
      quota_words integer NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending',
      paid_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  console.log('OK: table created');
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_bo_user ON billing_orders (user_id)
  `);
  console.log('OK: idx_bo_user created');
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_bo_created ON billing_orders (created_at)
  `);
  console.log('OK: idx_bo_created created');
  console.log('migration done');
})().catch((e) => {
  console.error('migration failed:', e.message);
  process.exit(1);
});
