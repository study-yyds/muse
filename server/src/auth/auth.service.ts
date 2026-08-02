import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq, and, gte } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { getDb, schema } from '../database/connection';
import { encryptPhone, decryptPhone } from './crypto.util';

function hashPhone(phone: string): string {
  return createHash('sha256').update(phone).digest('hex');
}

function decryptUser(user: any) {
  if (!user) return user;
  if (user.phone_encrypted) {
    try { user.phone_number = decryptPhone(user.phone_encrypted); } catch { /* 解密失败保留原文 */ }
  }
  return user;
}

@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  // 生成 6 位随机验证码（V1 用随机，V2 接短信服务）
  async sendCode(phone: string) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // 标记同手机号之前的验证码为已使用
    await getDb()
      .update(schema.verification_codes)
      .set({ used: true })
      .where(
        and(
          eq(schema.verification_codes.phone_number, phone),
          eq(schema.verification_codes.used, false),
        ),
      );

    // 写入新验证码（验证码本身不加密，按手机号明文匹配）
    await getDb().insert(schema.verification_codes).values({
      phone_number: phone,
      code,
      expires_at: expiresAt,
    });

    // V1 阶段直接返回验证码（生产环境不应返回）
    return { code };
  }

  // 验证码登录
  async login(phone: string, code: string) {
    const [record] = await getDb()
      .select()
      .from(schema.verification_codes)
      .where(
        and(
          eq(schema.verification_codes.phone_number, phone),
          eq(schema.verification_codes.code, code),
          eq(schema.verification_codes.used, false),
          gte(schema.verification_codes.expires_at, sql`NOW()`),
        ),
      )
      .limit(1);

    if (!record) {
      throw new Error('验证码错误或已过期');
    }

    // 标记验证码已使用
    await getDb()
      .update(schema.verification_codes)
      .set({ used: true })
      .where(eq(schema.verification_codes.id, record.id));

    // 查找或创建用户（通过 phone_hash 或 phone_number 查询）
    const phoneHash = hashPhone(phone);
    const db = getDb();
    let [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.phone_hash, phoneHash))
      .limit(1);

    if (!user) {
      const [newUser] = await db
        .insert(schema.users)
        .values({
          phone_number: phone,
          phone_hash: phoneHash,
          phone_encrypted: encryptPhone(phone),
        })
        .returning();
      user = newUser;
    }

    // 解密返回
    user = decryptUser(user);

    // 签发 JWT
    const token = this.jwt.sign({
      sub: user.user_id,
      phone: user.phone_number,
    });

    return { access_token: token, user_id: user.user_id };
  }

  async getProfile(userId: string) {
    const db = getDb();
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.user_id, userId))
      .limit(1);
    return decryptUser(user ?? null);
  }
}
