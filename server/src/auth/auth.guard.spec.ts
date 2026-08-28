import { AuthGuard } from './auth.guard';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';

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

  it('无 token 抛出 401', async () => {
    await expect(guard.canActivate(mockContext())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('有效 token 返回 true 并设置 userId', async () => {
    const token = jwt.sign({ sub: 'user-123' });
    const ctx = mockContext(token);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(ctx.switchToHttp().getRequest().userId).toBe('user-123');
  });

  it('无效 token 抛出 401', async () => {
    await expect(
      guard.canActivate(mockContext('invalid-token')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('过期 token 抛出 401', async () => {
    const token = jwt.sign({ sub: 'user-1' }, { expiresIn: '0s' });
    await expect(guard.canActivate(mockContext(token))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('封禁用户抛出 403', async () => {
    mockLimit.mockResolvedValueOnce([{ status: 'banned' }]);
    const token = jwt.sign({ sub: 'user-banned' });
    await expect(guard.canActivate(mockContext(token))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('暂停用户抛出 403', async () => {
    mockLimit.mockResolvedValueOnce([{ status: 'suspended' }]);
    const token = jwt.sign({ sub: 'user-suspended' });
    await expect(guard.canActivate(mockContext(token))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('用户不存在抛出 401', async () => {
    mockLimit.mockResolvedValueOnce([]);
    const token = jwt.sign({ sub: 'user-gone' });
    await expect(guard.canActivate(mockContext(token))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
