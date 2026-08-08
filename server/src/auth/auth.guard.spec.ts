import { AuthGuard } from './auth.guard';
import { JwtService } from '@nestjs/jwt';

function mockContext(token?: string) {
  const request: any = {
    headers: { authorization: token ? `Bearer ${token}` : undefined },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as any;
}

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let jwt: JwtService;

  beforeEach(() => {
    jwt = new JwtService({ secret: 'test-secret' });
    guard = new AuthGuard(jwt);
  });

  it('无 token 返回 false', () => {
    expect(guard.canActivate(mockContext())).toBe(false);
  });

  it('有效 token 返回 true 并设置 userId', () => {
    const token = jwt.sign({ sub: 'user-123' });
    const ctx = mockContext(token);
    expect(guard.canActivate(ctx)).toBe(true);
    expect((ctx.switchToHttp().getRequest() as any).userId).toBe('user-123');
  });

  it('无效 token 返回 false', () => {
    expect(guard.canActivate(mockContext('invalid-token'))).toBe(false);
  });

  it('过期 token 返回 false', () => {
    const token = jwt.sign({ sub: 'user-1' }, { expiresIn: '0s' });
    expect(guard.canActivate(mockContext(token))).toBe(false);
  });
});
