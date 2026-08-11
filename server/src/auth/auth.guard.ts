import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../database/connection';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;
    const match = authHeader?.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const token = match[1];
    if (!token) return false;

    try {
      const payload = this.jwt.verify(token);
      if (!payload.sub || typeof payload.sub !== 'string') return false;

      // 检查用户是否被封禁
      const [user] = await getDb()
        .select({ status: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.user_id, payload.sub))
        .limit(1);
      if (!user || user.status === 'banned') return false;

      request.userId = payload.sub;
      return true;
    } catch {
      return false;
    }
  }
}
