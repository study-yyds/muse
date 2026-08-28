import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

@Injectable()
export class CharactersService {
  async list(bookId: string) {
    const db = getDb();
    return db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.book_id, bookId))
      .orderBy(schema.characters.created_at);
  }

  private allowedFields = [
    'name',
    'gender',
    'appearance',
    'personality',
    'catchphrase',
    'speech_style',
    'identity',
    'backstory',
    'motivation',
    'custom_fields',
    'is_main',
    'aliases',
    'avatar_url',
  ];

  async create(bookId: string, data: any) {
    const db = getDb();
    const clean: any = { book_id: bookId };
    for (const f of this.allowedFields) {
      if (data[f] !== undefined) clean[f] = data[f];
    }
    const [char] = await db.insert(schema.characters).values(clean).returning();
    return char;
  }

  async update(charId: string, data: any, expectedBookId?: string) {
    const db = getDb();
    if (expectedBookId) {
      const [c] = await db
        .select({ book_id: schema.characters.book_id })
        .from(schema.characters)
        .where(eq(schema.characters.char_id, charId))
        .limit(1);
      if (!c || c.book_id !== expectedBookId)
        throw new Error('角色不属于该作品');
    }
    const clean: any = {};
    for (const f of this.allowedFields) {
      if (data[f] !== undefined) clean[f] = data[f];
    }
    await db
      .update(schema.characters)
      .set(clean)
      .where(eq(schema.characters.char_id, charId));
  }

  async delete(charId: string, bookId?: string) {
    const db = getDb();
    if (bookId) {
      const [c] = await db
        .select({ book_id: schema.characters.book_id })
        .from(schema.characters)
        .where(eq(schema.characters.char_id, charId))
        .limit(1);
      if (!c || c.book_id !== bookId) throw new Error('角色不属于该作品');
    }
    await db
      .delete(schema.characters)
      .where(eq(schema.characters.char_id, charId));
  }

  // 注：角色关系功能无前端入口，接口与实现已移除
}
