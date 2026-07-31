import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

@Injectable()
export class AdminGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.userId;
    if (!userId) return false;

    const [user] = await getDb()
      .select({ role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.user_id, userId))
      .limit(1);

    return user?.role === 'admin';
  }
}
