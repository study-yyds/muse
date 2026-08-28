import { Injectable } from '@nestjs/common';
import { eq, desc, sql } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

@Injectable()
export class AdminService {
  async listUsers(page: number = 1, pageSize: number = 20) {
    const db = getDb();
    const offset = (page - 1) * pageSize;

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.users);

    const users = await db
      .select({
        user_id: schema.users.user_id,
        phone_number: schema.users.phone_number,
        role: schema.users.role,
        status: schema.users.status,
        book_limit: schema.users.book_limit,
        created_at: schema.users.created_at,
        updated_at: schema.users.updated_at,
      })
      .from(schema.users)
      .orderBy(desc(schema.users.created_at))
      .limit(pageSize)
      .offset(offset);

    // 每个用户的 token 用量
    const enriched = await Promise.all(
      users.map(async (u) => {
        const [usage] = await db
          .select({
            total_tokens: sql<number>`coalesce(sum(${schema.token_usage_records.token_count}), 0)::int`,
            request_count: sql<number>`count(${schema.token_usage_records.id})::int`,
          })
          .from(schema.token_usage_records)
          .where(eq(schema.token_usage_records.user_id, u.user_id));
        return { ...u, ...usage };
      }),
    );

    return { items: enriched, total: countRow?.count ?? 0, page, pageSize };
  }

  async updateUser(
    userId: string,
    data: { role?: string; status?: string; book_limit?: number },
  ) {
    const db = getDb();
    const updateData: any = { updated_at: sql`NOW()` };
    if (data.role) updateData.role = data.role;
    if (data.status) updateData.status = data.status;
    if (data.book_limit != null) updateData.book_limit = data.book_limit;
    await db
      .update(schema.users)
      .set(updateData)
      .where(eq(schema.users.user_id, userId));
    return { message: '已更新' };
  }

  async getUserUsage(userId: string, months: number = 6) {
    const db = getDb();
    const monthExpr = sql<string>`to_char(${schema.token_usage_records.created_at}, 'YYYY-MM')`;
    const records = await db
      .select({
        month: monthExpr,
        total_tokens: sql<number>`sum(${schema.token_usage_records.token_count})::int`,
        request_count: sql<number>`count(${schema.token_usage_records.id})::int`,
      })
      .from(schema.token_usage_records)
      .where(eq(schema.token_usage_records.user_id, userId))
      .groupBy(monthExpr)
      .orderBy(desc(monthExpr))
      .limit(months);
    return records;
  }

  /** 平台总用量：全站 token 总量 + 请求数 + 按模型聚合 */
  async getPlatformUsage() {
    const db = getDb();
    const [total] = await db
      .select({
        total_tokens: sql<number>`coalesce(sum(${schema.token_usage_records.token_count}), 0)::int`,
        request_count: sql<number>`count(${schema.token_usage_records.id})::int`,
      })
      .from(schema.token_usage_records);
    const byModel = await db
      .select({
        model_name: schema.token_usage_records.model_name,
        total_tokens: sql<number>`sum(${schema.token_usage_records.token_count})::int`,
        request_count: sql<number>`count(${schema.token_usage_records.id})::int`,
      })
      .from(schema.token_usage_records)
      .groupBy(schema.token_usage_records.model_name)
      .orderBy(desc(sql`sum(${schema.token_usage_records.token_count})`));
    return { total, by_model: byModel };
  }
}
