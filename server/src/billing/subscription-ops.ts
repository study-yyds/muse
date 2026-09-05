// 订阅到期自动降级：把过期付费用户额度降回免费档。
// 两条触发路径共用同一套规则（单一实现，防逻辑分叉）：
// 1. maintenance 每小时全量扫描（downgradeExpiredSubscriptions）
// 2. ai 额度检查前惰性单用户检查（downgradeExpiredForUser）
//    ——堵住"到期时刻到下一次扫描之间"的窗口，避免平台垫付超额用量
//
// 降级规则：用户最新 paid 订单已过期，且当前额度仍等于该订单写入的档位额度
// （说明额度未被 admin 手动改过），才降回免费档。
// 每张过期订单只评估一次（downgraded_at 打标）：之后 admin 的手动额度调整
// 永久生效，不会被后续扫描/请求重复回退。
// 本月已用字数不清零（与升级语义一致），降级后额度不足由既有拦截自然生效。

import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

/** 免费档月额度（与 client/src/lib/plans.ts PLANS.free.words 一致） */
export const FREE_WORDS_QUOTA = 30000;

/** 惰性降级：用户最新 paid 订单已过期 → 额度降回免费档。返回是否执行了降级 */
export async function downgradeExpiredForUser(
  userId: string,
): Promise<boolean> {
  const db = getDb();
  // 最新 paid 订单决定订阅状态（续费 = 新订单 expires_at 更晚，自动覆盖旧订单）
  const [order] = await db
    .select({
      id: schema.billing_orders.id,
      quota_words: schema.billing_orders.quota_words,
      expires_at: schema.billing_orders.expires_at,
      downgraded_at: schema.billing_orders.downgraded_at,
    })
    .from(schema.billing_orders)
    .where(
      and(
        eq(schema.billing_orders.user_id, userId),
        eq(schema.billing_orders.status, 'paid'),
        isNotNull(schema.billing_orders.expires_at),
      ),
    )
    .orderBy(desc(schema.billing_orders.expires_at))
    .limit(1);
  if (!order?.expires_at) return false;
  if (order.expires_at.getTime() > Date.now()) return false; // 未到期
  if (order.downgraded_at) return false; // 已评估过：之后 admin 的额度调整永久生效

  // 已过期但未评估：仅当当前额度仍是该订单支付时写入的档位额度才降级
  // （admin 手动调过的自定义额度不误伤；已被其他渠道改过的不重复降）
  const [user] = await db
    .select({ quota: schema.users.monthly_words_quota })
    .from(schema.users)
    .where(eq(schema.users.user_id, userId))
    .limit(1);
  const shouldDowngrade =
    !!user && user.quota === order.quota_words && user.quota !== FREE_WORDS_QUOTA;
  if (!shouldDowngrade) {
    // 额度已被 admin 改过 / 已免费：只打标记录评估，不动额度
    await db
      .update(schema.billing_orders)
      .set({ downgraded_at: new Date() })
      .where(eq(schema.billing_orders.id, order.id));
    return false;
  }
  // 先降额度后打标：任一步失败下次重试（未打标会重新评估，幂等）
  await db
    .update(schema.users)
    .set({ monthly_words_quota: FREE_WORDS_QUOTA })
    .where(eq(schema.users.user_id, userId));
  await db
    .update(schema.billing_orders)
    .set({ downgraded_at: new Date() })
    .where(eq(schema.billing_orders.id, order.id));
  return true;
}

/** 全量扫描：找出全部已过期付费用户并逐个惰性降级，返回降级数量（maintenance 每小时调用） */
export async function downgradeExpiredSubscriptions(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ user_id: schema.billing_orders.user_id })
    .from(schema.billing_orders)
    .where(
      and(
        eq(schema.billing_orders.status, 'paid'),
        isNotNull(schema.billing_orders.expires_at),
        lt(schema.billing_orders.expires_at, new Date()),
      ),
    );
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  let downgraded = 0;
  for (const id of userIds) {
    try {
      if (await downgradeExpiredForUser(id)) downgraded++;
    } catch (e: any) {
      console.error('[billing] downgrade failed for user', id, e.message);
    }
  }
  return downgraded;
}
