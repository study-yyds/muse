import { BookOwnerGuard } from './book-owner.guard';

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
};

jest.mock('../database/connection', () => ({
  getDb: () => mockDb,
  schema: { books: { book_id: 'b_id', user_id: 'b_uid' } },
}));

function mockContext(userId?: string, bookId?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        userId,
        params: bookId ? { bookId } : {},
      }),
    }),
  } as any;
}

describe('BookOwnerGuard', () => {
  let guard: BookOwnerGuard;

  beforeEach(() => {
    guard = new BookOwnerGuard();
    jest.clearAllMocks();
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
  });

  it('无 userId 返回 false', async () => {
    expect(await guard.canActivate(mockContext(undefined, 'book-1'))).toBe(false);
  });

  it('路由无 bookId 参数时直接放行', async () => {
    expect(await guard.canActivate(mockContext('user-1'))).toBe(true);
  });

  it('用户是书籍拥有者返回 true', async () => {
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnValue(Promise.resolve([{ user_id: 'user-1' }]));
    expect(await guard.canActivate(mockContext('user-1', 'book-1'))).toBe(true);
  });

  it('用户不是书籍拥有者返回 false', async () => {
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnValue(Promise.resolve([{ user_id: 'other-user' }]));
    expect(await guard.canActivate(mockContext('user-1', 'book-1'))).toBe(false);
  });

  it('书籍不存在返回 false', async () => {
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnValue(Promise.resolve([]));
    expect(await guard.canActivate(mockContext('user-1', 'book-1'))).toBe(false);
  });
});
