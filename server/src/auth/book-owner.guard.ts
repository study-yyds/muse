import {
  Injectable,
  CanActivate,
  ExecutionContext,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

export const ALLOW_DELETED_KEY = 'allow-deleted-book';
/** 允许访问已软删除作品的接口（恢复/永久删除）使用此装饰器豁免拦截 */
export const AllowDeleted = () => SetMetadata(ALLOW_DELETED_KEY, true);

/** 校验当前用户是否拥有 :bookId 对应的作品，并拦截已软删除的作品 */
@Injectable()
export class BookOwnerGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.userId;
    const bookId = request.params?.bookId;
    if (!userId) return false;
    if (!bookId) return true; // 路由中没有 bookId 参数，放行

    const [book] = await getDb()
      .select({
        user_id: schema.books.user_id,
        deleted_at: schema.books.deleted_at,
      })
      .from(schema.books)
      .where(eq(schema.books.book_id, bookId))
      .limit(1);

    if (!book || book.user_id !== userId) {
      throw new NotFoundException('作品不存在');
    }

    // 软删除的作品一律 404（恢复/永久删除接口通过 @AllowDeleted 豁免），
    // 防止删除后另一标签页继续读写
    const allowDeleted = this.reflector.getAllAndOverride<boolean>(
      ALLOW_DELETED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (book.deleted_at && !allowDeleted) {
      throw new NotFoundException('作品不存在');
    }

    return true;
  }
}
