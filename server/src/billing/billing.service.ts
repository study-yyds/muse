import { Injectable, BadRequestException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

/**
 * 套餐档位（服务端权威定义，客户端 lib/plans.ts 仅作展示）
 * 模拟支付阶段：pay-mock 直接标记已支付并应用额度；
 * 真实支付接入后，pay 环节替换为网关回调/主动查询，其余不变。
 */
export const SERVER_PLANS: Record<
  string,
  { price: string; words: number; name: string }
> = {
  basic: { name: '基础版', price: '¥19/月', words: 300000 },
  pro: { name: '专业版', price: '¥49/月', words: 1000000 },
};

@Injectable()
export class BillingService {
  /** 创建订单（待支付） */
  async createOrder(userId: string, planId: string) {
    const plan = SERVER_PLANS[planId];
    if (!plan) {
      throw new BadRequestException('无效的套餐档位');
    }
    const db = getDb();
    const [order] = await db
      .insert(schema.billing_orders)
      .values({
        user_id: userId,
        plan_id: planId,
        amount: plan.price,
        quota_words: plan.words,
        status: 'pending',
      })
      .returning();
    return order;
  }

  /** 模拟支付：标记已支付 + 应用额度（真实支付接入后此方法换为网关校验） */
  async payMockOrder(userId: string, orderId: string) {
    const db = getDb();
    const [order] = await db
      .select()
      .from(schema.billing_orders)
      .where(
        and(
          eq(schema.billing_orders.id, orderId),
          eq(schema.billing_orders.user_id, userId),
        ),
      )
      .limit(1);
    if (!order) {
      throw new BadRequestException('订单不存在');
    }
    if (order.status === 'paid') {
      throw new BadRequestException('订单已支付');
    }
    if (order.status === 'cancelled') {
      throw new BadRequestException('订单已取消');
    }

    await db
      .update(schema.billing_orders)
      .set({ status: 'paid', paid_at: new Date() })
      .where(eq(schema.billing_orders.id, orderId));
    // 应用额度：替换为档位额度（本月已用字数保留，不清零）
    await db
      .update(schema.users)
      .set({ monthly_words_quota: order.quota_words })
      .where(eq(schema.users.user_id, userId));

    const { monthly_words_quota } = await this.getCurrentQuota(userId);
    return {
      order_id: orderId,
      plan_id: order.plan_id,
      quota_words: monthly_words_quota,
    };
  }

  /** 取消订单（模拟收银台点"取消"时调用，避免 pending 订单堆积） */
  async cancelOrder(userId: string, orderId: string) {
    const db = getDb();
    const [order] = await db
      .select({ status: schema.billing_orders.status })
      .from(schema.billing_orders)
      .where(
        and(
          eq(schema.billing_orders.id, orderId),
          eq(schema.billing_orders.user_id, userId),
        ),
      )
      .limit(1);
    if (!order) {
      throw new BadRequestException('订单不存在');
    }
    if (order.status === 'pending') {
      await db
        .update(schema.billing_orders)
        .set({ status: 'cancelled' })
        .where(eq(schema.billing_orders.id, orderId));
    }
    return { message: '已取消' };
  }

  /** 用户订单列表（倒序） */
  async listOrders(userId: string) {
    const db = getDb();
    return db
      .select()
      .from(schema.billing_orders)
      .where(eq(schema.billing_orders.user_id, userId))
      .orderBy(desc(schema.billing_orders.created_at))
      .limit(50);
  }

  /** 当前额度（供支付后回显） */
  private async getCurrentQuota(userId: string) {
    const db = getDb();
    const [u] = await db
      .select({ monthly_words_quota: schema.users.monthly_words_quota })
      .from(schema.users)
      .where(eq(schema.users.user_id, userId))
      .limit(1);
    return u ?? { monthly_words_quota: 0 };
  }
}
