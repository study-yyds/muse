import { Injectable } from '@nestjs/common';
import { eq, or } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

@Injectable()
export class CharactersService {
  async list(bookId: string) {
    const db = getDb();
    return db.select().from(schema.characters).where(eq(schema.characters.book_id, bookId));
  }

  async create(bookId: string, data: any) {
    const db = getDb();
    const [char] = await db.insert(schema.characters).values({ book_id: bookId, ...data }).returning();
    return char;
  }

  async update(charId: string, data: any) {
    const db = getDb();
    await db.update(schema.characters).set(data).where(eq(schema.characters.char_id, charId));
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
