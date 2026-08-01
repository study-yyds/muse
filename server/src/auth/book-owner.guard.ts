import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

/** 校验当前用户是否拥有 :bookId 对应的作品 */
@Injectable()
export class BookOwnerGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.userId;
    const bookId = request.params?.bookId;
    if (!userId) return false;
    if (!bookId) return true; // 路由中没有 bookId 参数，放行

    const [book] = await getDb()
      .select({ user_id: schema.books.user_id })
      .from(schema.books)
      .where(eq(schema.books.book_id, bookId))
      .limit(1);

    return book?.user_id === userId;
  }
}
