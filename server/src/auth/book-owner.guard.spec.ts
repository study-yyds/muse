import { BookOwnerGuard } from './book-owner.guard';
import { NotFoundException } from '@nestjs/common';

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
};

jest.mock('../database/connection', () => ({
  getDb: () => mockDb,
  schema: {
    books: { book_id: 'b_id', user_id: 'b_uid', deleted_at: 'b_deleted' },
  },
}));

function mockContext(userId?: string, bookId?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        userId,
        params: bookId ? { bookId } : {},
      }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

function makeGuard(allowDeleted = false): BookOwnerGuard {
  return new BookOwnerGuard({
    getAllAndOverride: jest.fn(() => allowDeleted),
  } as any);
}

describe('BookOwnerGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
  });

  it('无 userId 返回 false', async () => {
    expect(
      await makeGuard().canActivate(mockContext(undefined, 'book-1')),
    ).toBe(false);
  });

  it('路由无 bookId 参数时直接放行', async () => {
    expect(await makeGuard().canActivate(mockContext('user-1'))).toBe(true);
  });

  it('用户是书籍拥有者返回 true', async () => {
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnValue(
      Promise.resolve([{ user_id: 'user-1', deleted_at: null }]),
    );
    expect(await makeGuard().canActivate(mockContext('user-1', 'book-1'))).toBe(
      true,
    );
  });

  it('用户不是书籍拥有者抛出 404', async () => {
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnValue(
      Promise.resolve([{ user_id: 'other-user', deleted_at: null }]),
    );
    await expect(
      makeGuard().canActivate(mockContext('user-1', 'book-1')),
    ).rejects.toThrow(NotFoundException);
  });

  it('书籍不存在抛出 404', async () => {
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnValue(Promise.resolve([]));
    await expect(
      makeGuard().canActivate(mockContext('user-1', 'book-1')),
    ).rejects.toThrow(NotFoundException);
  });

  it('已软删除的作品抛出 404', async () => {
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnValue(
      Promise.resolve([{ user_id: 'user-1', deleted_at: new Date() }]),
    );
    await expect(
      makeGuard().canActivate(mockContext('user-1', 'book-1')),
    ).rejects.toThrow(NotFoundException);
  });

  it('已软删除的作品带 @AllowDeleted 豁免时放行', async () => {
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnValue(
      Promise.resolve([{ user_id: 'user-1', deleted_at: new Date() }]),
    );
    expect(
      await makeGuard(true).canActivate(mockContext('user-1', 'book-1')),
    ).toBe(true);
  });
});
