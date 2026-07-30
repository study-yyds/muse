import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

@Injectable()
export class WorldService {
  async get(bookId: string) {
    const db = getDb();
    const [ws] = await db
      .select()
      .from(schema.world_settings)
      .where(eq(schema.world_settings.book_id, bookId))
      .limit(1);
    return ws ?? null;
  }

  async save(bookId: string, sections: any[]) {
    const db = getDb();
    const existing = await this.get(bookId);
    if (existing) {
      await db
        .update(schema.world_settings)
        .set({ sections, updated_at: sql`NOW()` })
        .where(eq(schema.world_settings.book_id, bookId));
    } else {
      await db
        .insert(schema.world_settings)
        .values({ book_id: bookId, sections });
    }
  }
}
