import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;
    const match = authHeader?.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const token = match[1];
    if (!token) return false;

    try {
      const payload = this.jwt.verify(token);
      if (!payload.sub || typeof payload.sub !== 'string') return false;
      request.userId = payload.sub;
      return true;
    } catch {
      return false;
    }
  }
}
