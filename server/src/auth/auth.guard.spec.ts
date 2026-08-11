import { AuthGuard } from './auth.guard';
import { JwtService } from '@nestjs/jwt';

const mockLimit = jest.fn().mockResolvedValue([{ status: 'active' }]);
const mockWhere = jest.fn().mockReturnValue({ limit: mockLimit });
const mockFrom = jest.fn().mockReturnValue({ where: mockWhere });

jest.mock('../database/connection', () => ({
  getDb: () => ({
    select: jest.fn().mockReturnValue({ from: mockFrom }),
  }),
  schema: {
    users: {
      user_id: 'user_id',
      status: 'status',
    },
  },
}));

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
    jest.clearAllMocks();
    mockLimit.mockResolvedValue([{ status: 'active' }]);
    jwt = new JwtService({ secret: 'test-secret' });
    guard = new AuthGuard(jwt);
  });

  it('无 token 返回 false', async () => {
    expect(await guard.canActivate(mockContext())).toBe(false);
  });

  it('有效 token 返回 true 并设置 userId', async () => {
    const token = jwt.sign({ sub: 'user-123' });
    const ctx = mockContext(token);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect((ctx.switchToHttp().getRequest() as any).userId).toBe('user-123');
  });

  it('无效 token 返回 false', async () => {
    expect(await guard.canActivate(mockContext('invalid-token'))).toBe(false);
  });

  it('过期 token 返回 false', async () => {
    const token = jwt.sign({ sub: 'user-1' }, { expiresIn: '0s' });
    expect(await guard.canActivate(mockContext(token))).toBe(false);
  });

  it('封禁用户 token 返回 false', async () => {
    mockLimit.mockResolvedValueOnce([{ status: 'banned' }]);
    const token = jwt.sign({ sub: 'user-banned' });
    expect(await guard.canActivate(mockContext(token))).toBe(false);
  });
});
