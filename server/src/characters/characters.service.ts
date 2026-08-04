import { Injectable } from '@nestjs/common';
import { eq, or } from 'drizzle-orm';
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
    'name', 'gender', 'age', 'appearance', 'personality',
    'catchphrase', 'speech_style', 'identity', 'backstory',
    'motivation', 'custom_fields', 'is_main', 'aliases',
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
      const [c] = await db.select({ book_id: schema.characters.book_id }).from(schema.characters).where(eq(schema.characters.char_id, charId)).limit(1);
      if (!c || c.book_id !== expectedBookId) throw new Error('角色不属于该作品');
    }
    const clean: any = {};
    for (const f of this.allowedFields) {
      if (data[f] !== undefined) clean[f] = data[f];
    }
    await db.update(schema.characters).set(clean).where(eq(schema.characters.char_id, charId));
  }

  async delete(charId: string) {
    const db = getDb();
    await db.delete(schema.characters).where(eq(schema.characters.char_id, charId));
  }

  // 角色关系
  async listRelations(charId: string) {
    const db = getDb();
    return db.select().from(schema.character_relations).where(or(eq(schema.character_relations.source_char_id, charId), eq(schema.character_relations.target_char_id, charId)));
  }

  async addRelation(charId: string, body: { target_char_id: string; relation_type: string; description?: string }) {
    const db = getDb();
    const [rel] = await db.insert(schema.character_relations).values({ source_char_id: charId, target_char_id: body.target_char_id, relation_type: body.relation_type, description: body.description }).returning();
    return rel;
  }

  async deleteRelation(relationId: string) {
    const db = getDb();
    await db.delete(schema.character_relations).where(eq(schema.character_relations.id, relationId));
  }
}
