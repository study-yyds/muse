import { Injectable } from '@nestjs/common';
import { eq, desc, sql, and, like, or } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';
import { abortBookRequests } from '../ai/abort-registry';

@Injectable()
export class AdminService {
  async listUsers(
    page: number = 1,
    pageSize: number = 20,
    phone?: string,
  ) {
    const db = getDb();
    const offset = (page - 1) * pageSize;
    const phoneFilter = phone?.trim();

    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.users)
      .where(
        phoneFilter
          ? like(schema.users.phone_number, `%${phoneFilter}%`)
          : undefined,
      );

    const users = await db
      .select({
        user_id: schema.users.user_id,
        phone_number: schema.users.phone_number,
        role: schema.users.role,
        status: schema.users.status,
        book_limit: schema.users.book_limit,
        monthly_words_quota: schema.users.monthly_words_quota,
        created_at: schema.users.created_at,
        updated_at: schema.users.updated_at,
      })
      .from(schema.users)
      .where(
        phoneFilter
          ? like(schema.users.phone_number, `%${phoneFilter}%`)
          : undefined,
      )
      .orderBy(desc(schema.users.created_at))
      .limit(pageSize)
      .offset(offset);

    // 聚合查询一次取回全部（避免 N+1）：累计 token + 本月字数 + 真实作品数
    const ids = users.map((u) => u.user_id);
    const aggregates: Record<string, { total_tokens: number; request_count: number; month_words: number; book_count: number }> = {};
    if (ids.length > 0) {
      const now = new Date();
      const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const inIds = sql`${schema.token_usage_records.user_id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`;
      const tokenRows = await db
        .select({
          user_id: schema.token_usage_records.user_id,
          total_tokens: sql<number>`sum(${schema.token_usage_records.token_count})::int`,
          request_count: sql<number>`count(${schema.token_usage_records.id})::int`,
        })
        .from(schema.token_usage_records)
        .where(inIds)
        .groupBy(schema.token_usage_records.user_id);
      for (const r of tokenRows) {
        aggregates[r.user_id] = { total_tokens: r.total_tokens ?? 0, request_count: r.request_count ?? 0, month_words: 0, book_count: 0 };
      }
      const monthRows = await db
        .select({
          user_id: schema.user_monthly_quota.user_id,
          used_words: schema.user_monthly_quota.used_words,
        })
        .from(schema.user_monthly_quota)
        .where(
          and(
            sql`${schema.user_monthly_quota.user_id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`,
            eq(schema.user_monthly_quota.month, curMonth),
          ),
        );
      for (const r of monthRows) {
        if (!aggregates[r.user_id]) {
          aggregates[r.user_id] = { total_tokens: 0, request_count: 0, month_words: 0, book_count: 0 };
        }
        aggregates[r.user_id].month_words = r.used_words ?? 0;
      }
      // 真实作品数（未删除的作品）
      const bookRows = await db
        .select({
          user_id: schema.books.user_id,
          book_count: sql<number>`count(*)::int`,
        })
        .from(schema.books)
        .where(
          and(
            sql`${schema.books.user_id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`,
            sql`${schema.books.deleted_at} IS NULL`,
          ),
        )
        .groupBy(schema.books.user_id);
      for (const r of bookRows) {
        if (!aggregates[r.user_id]) {
          aggregates[r.user_id] = { total_tokens: 0, request_count: 0, month_words: 0, book_count: 0 };
        }
        aggregates[r.user_id].book_count = r.book_count ?? 0;
      }
    }
    const enriched = users.map((u) => ({
      ...u,
      ...(aggregates[u.user_id] ?? { total_tokens: 0, request_count: 0, month_words: 0, book_count: 0 }),
    }));

    return { items: enriched, total: countRow?.count ?? 0, page, pageSize };
  }

  async updateUser(
    operatorId: string,
    userId: string,
    data: {
      role?: string;
      status?: string;
      book_limit?: number;
      monthly_words_quota?: number;
    },
  ) {
    const db = getDb();

    // 安全保护 1：不能操作自己的账户（防止误锁后台/自我提权历史隐患）
    if (operatorId === userId) {
      throw new Error('不能修改自己的账户');
    }

    // 安全保护 2：不能降级/封禁最后一名管理员（防止后台锁死）
    const isDangerous =
      data.role === 'user' ||
      data.status === 'suspended' ||
      data.status === 'banned';
    if (isDangerous) {
      const [target] = await db
        .select({ role: schema.users.role })
        .from(schema.users)
        .where(eq(schema.users.user_id, userId))
        .limit(1);
      if (target?.role === 'admin') {
        const [otherAdmins] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.users)
          .where(
            and(
              eq(schema.users.role, 'admin'),
              sql`${schema.users.user_id} <> ${userId}`,
            ),
          );
        if ((otherAdmins?.count ?? 0) === 0) {
          throw new Error('不能降级/封禁最后一名管理员');
        }
      }
    }

    const updateData: any = { updated_at: sql`NOW()` };
    if (data.role) updateData.role = data.role;
    if (data.status) updateData.status = data.status;
    if (data.book_limit != null) updateData.book_limit = data.book_limit;
    if (data.monthly_words_quota != null) {
      updateData.monthly_words_quota = data.monthly_words_quota;
    }
    await db
      .update(schema.users)
      .set(updateData)
      .where(eq(schema.users.user_id, userId));

    // 封禁/暂停：中止该用户全部作品进行中的 AI 生成（停止烧钱）
    if (data.status === 'suspended' || data.status === 'banned') {
      const books = await db
        .select({ book_id: schema.books.book_id })
        .from(schema.books)
        .where(eq(schema.books.user_id, userId));
      for (const b of books) abortBookRequests(b.book_id);
    }

    // 审计日志：记录谁对谁做了什么
    await db.insert(schema.admin_audit_logs).values({
      operator_id: operatorId,
      target_user_id: userId,
      action: 'update_user',
      detail: data as any,
    });

    return { message: '已更新' };
  }

  /** 最近的管理员操作审计（倒序，最近 50 条） */
  async listAuditLogs(limit: number = 50) {
    const db = getDb();
    const logs = await db
      .select({
        id: schema.admin_audit_logs.id,
        operator_id: schema.admin_audit_logs.operator_id,
        target_user_id: schema.admin_audit_logs.target_user_id,
        action: schema.admin_audit_logs.action,
        detail: schema.admin_audit_logs.detail,
        created_at: schema.admin_audit_logs.created_at,
      })
      .from(schema.admin_audit_logs)
      .orderBy(desc(schema.admin_audit_logs.created_at))
      .limit(Math.min(Math.max(limit, 1), 200));
    // 关联手机号（operator 可能已被删除 set null）
    const userIds = [
      ...new Set(
        logs
          .map((l) => [l.operator_id, l.target_user_id])
          .flat()
          .filter((id): id is string => !!id),
      ),
    ];
    const phoneMap: Record<string, string> = {};
    if (userIds.length > 0) {
      const rows = await db
        .select({
          user_id: schema.users.user_id,
          phone_number: schema.users.phone_number,
        })
        .from(schema.users)
        .where(
          sql`${schema.users.user_id} IN (${sql.join(userIds.map((id) => sql`${id}`), sql`,`)})`,
        );
      for (const r of rows) phoneMap[r.user_id] = r.phone_number;
    }
    return logs.map((l) => ({
      ...l,
      operator_phone: l.operator_id ? (phoneMap[l.operator_id] ?? '已删除') : '-',
      target_phone: l.target_user_id ? (phoneMap[l.target_user_id] ?? '已删除') : '-',
    }));
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
