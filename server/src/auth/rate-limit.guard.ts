import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Response } from 'express';

interface Window {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private windows = new Map<string, Window>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests = 10, windowMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse<Response>();
    const userId = request.userId;

    if (!userId) {
      // 未登录不限制（AuthGuard 会拦截）
      return true;
    }

    const now = Date.now();
    const key = `rate:${userId}`;
    let window = this.windows.get(key);

    if (!window || now > window.resetAt) {
      window = { count: 1, resetAt: now + this.windowMs };
      this.windows.set(key, window);
      res.setHeader('X-RateLimit-Limit', this.maxRequests);
      res.setHeader('X-RateLimit-Remaining', this.maxRequests - 1);
      res.setHeader('X-RateLimit-Reset', Math.ceil(window.resetAt / 1000));
      return true;
    }

    window.count++;

    if (window.count > this.maxRequests) {
      res.status(429);
      res.setHeader('X-RateLimit-Limit', this.maxRequests);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil(window.resetAt / 1000));
      res.setHeader('Retry-After', Math.ceil((window.resetAt - now) / 1000));
      res.json({ code: 429, message: '请求过于频繁，请稍后再试' });
      return false;
    }

    res.setHeader('X-RateLimit-Limit', this.maxRequests);
    res.setHeader('X-RateLimit-Remaining', this.maxRequests - window.count);
    res.setHeader('X-RateLimit-Reset', Math.ceil(window.resetAt / 1000));
    return true;
  }
}
