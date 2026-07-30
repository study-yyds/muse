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
      .where(eq(schema.characters.book_id, bookId));
  }

  async create(bookId: string, data: any) {
    const db = getDb();
    const [char] = await db
      .insert(schema.characters)
      .values({ book_id: bookId, ...data })
      .returning();
    return char;
  }

  async update(charId: string, data: any) {
    const db = getDb();
    await db
      .update(schema.characters)
      .set(data)
      .where(eq(schema.characters.char_id, charId));
  }

  async delete(charId: string) {
    const db = getDb();
    await db
      .delete(schema.characters)
      .where(eq(schema.characters.char_id, charId));
  }
}
