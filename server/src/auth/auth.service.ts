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

    // 查找或创建用户：phone_hash 优先，phone_number 兜底（兼容老用户无哈希）
    const phoneHash = hashPhone(phone);
    const db = getDb();
    let [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.phone_hash, phoneHash))
      .limit(1);

    if (!user) {
      // 兼容老用户：通过明文手机号查找
      [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.phone_number, phone))
        .limit(1);
    }

    if (!user) {
      // 真正的新用户
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

  // ============ API Key 管理 ============

  private encryptApiKey(plaintext: string): { encrypted: string; iv: string } {
    const { createCipheriv, randomBytes } = require('crypto');
    const key = require('crypto')
      .createHash('sha256')
      .update(process.env.ENCRYPTION_KEY || 'muse-dev-key')
      .digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      encrypted: Buffer.concat([tag, encrypted]).toString('base64'),
      iv: iv.toString('base64'),
    };
  }

  // 解密（仅用于内部 useApiKey）
  decryptApiKey(encrypted: string, iv: string): string {
    const { createDecipheriv } = require('crypto');
    const key = require('crypto')
      .createHash('sha256')
      .update(process.env.ENCRYPTION_KEY || 'muse-dev-key')
      .digest();
    const buf = Buffer.from(encrypted, 'base64');
    const tag = buf.subarray(0, 16);
    const data = buf.subarray(16);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  }

  async listApiKeys(userId: string) {
    const db = getDb();
    const rows = await db
      .select({
        id: schema.user_api_keys.id,
        name: schema.user_api_keys.name,
        model_name: schema.user_api_keys.model_name,
        usage: schema.user_api_keys.usage,
        is_active: schema.user_api_keys.is_active,
        created_at: schema.user_api_keys.created_at,
      })
      .from(schema.user_api_keys)
      .where(eq(schema.user_api_keys.user_id, userId))
      .orderBy(schema.user_api_keys.created_at);
    return rows;
  }

  async createApiKey(
    userId: string,
    body: { name: string; api_key: string; base_url: string; model_name: string; usage: string },
  ) {
    const db = getDb();
    const { encrypted, iv } = this.encryptApiKey(body.api_key);
    const [row] = await db
      .insert(schema.user_api_keys)
      .values({
        user_id: userId,
        name: body.name || '未命名',
        api_key_encrypted: encrypted,
        encryption_iv: iv,
        base_url: body.base_url,
        model_name: body.model_name,
        usage: body.usage || 'chat',
      } as any)
      .returning();
    return row;
  }

  async updateApiKey(
    id: string,
    userId: string,
    body: { name?: string; api_key?: string; base_url?: string; model_name?: string; usage?: string; is_active?: boolean },
  ) {
    const db = getDb();
    const updateData: any = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.base_url !== undefined) updateData.base_url = body.base_url;
    if (body.model_name !== undefined) updateData.model_name = body.model_name;
    if (body.usage !== undefined) updateData.usage = body.usage;
    if (body.is_active !== undefined) updateData.is_active = body.is_active;
    if (body.api_key) {
      const { encrypted, iv } = this.encryptApiKey(body.api_key);
      updateData.api_key_encrypted = encrypted;
      updateData.encryption_iv = iv;
    }
    await db
      .update(schema.user_api_keys)
      .set(updateData)
      .where(
        and(
          eq(schema.user_api_keys.id, id),
          eq(schema.user_api_keys.user_id, userId),
        ),
      );
  }

  async deleteApiKey(id: string, userId: string) {
    const db = getDb();
    await db
      .delete(schema.user_api_keys)
      .where(
        and(
          eq(schema.user_api_keys.id, id),
          eq(schema.user_api_keys.user_id, userId),
        ),
      );
  }

  /** 获取用户活跃的 API Key（文本用途） */
  async getActiveApiKeys(userId: string, usage: string) {
    const db = getDb();
    return db
      .select()
      .from(schema.user_api_keys)
      .where(
        and(
          eq(schema.user_api_keys.user_id, userId),
          eq(schema.user_api_keys.is_active, true),
          eq(schema.user_api_keys.usage, usage),
        ),
      );
  }
}
