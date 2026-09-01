import { BillingService, SERVER_PLANS } from './billing.service';
import { BadRequestException } from '@nestjs/common';

// Mock DB：链式 mock（与 admin.service.spec 同款）
const mockDb: any = {
  select: jest.fn(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn(),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
};

jest.mock('../database/connection', () => ({
  getDb: () => mockDb,
  schema: {
    billing_orders: {
      id: 'id',
      user_id: 'user_id',
      plan_id: 'plan_id',
      amount: 'amount',
      quota_words: 'quota_words',
      status: 'status',
      paid_at: 'paid_at',
      created_at: 'created_at',
    },
    users: { user_id: 'user_id', monthly_words_quota: 'monthly_words_quota' },
  },
}));

/** 构造一次 select 链：返回 rows */
const sel = (rows: any[]) => {
  const limit = jest.fn().mockResolvedValue(rows);
  const thenable = {
    limit,
    then: (fn: any) => limit().then(fn),
  };
  const where = jest.fn().mockReturnValue(thenable);
  const from = jest.fn().mockReturnValue({ where });
  return { from };
};

describe('BillingService', () => {
  let service: BillingService;

  beforeEach(() => {
    service = new BillingService();
    jest.clearAllMocks();
    Object.keys(mockDb).forEach((k) => {
      if (
        typeof mockDb[k] === 'function' &&
        !['insert', 'select', 'update'].includes(k)
      ) {
        mockDb[k] = jest.fn().mockReturnThis();
      }
    });
    mockDb.insert = jest.fn().mockReturnThis();
    mockDb.update = jest.fn().mockReturnThis();
    mockDb.select = jest.fn();
    mockDb.values = jest.fn().mockReturnThis();
    mockDb.returning = jest
      .fn()
      .mockResolvedValue([{ id: 'o1', status: 'pending' }]);
    mockDb.set = jest.fn().mockReturnThis();
  });

  it('无效档位拒绝下单', async () => {
    await expect(service.createOrder('u1', 'vip999')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('创建订单返回待支付订单', async () => {
    const order = await service.createOrder('u1', 'basic');
    expect(order).toMatchObject({ id: 'o1', status: 'pending' });
    expect(mockDb.values).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_id: 'basic',
        quota_words: SERVER_PLANS.basic.words,
      }),
    );
  });

  it('模拟支付：校验归属与状态，应用额度', async () => {
    mockDb.select
      .mockReturnValueOnce(
        sel([
          {
            id: 'o1',
            user_id: 'u1',
            plan_id: 'basic',
            status: 'pending',
            quota_words: 300000,
          },
        ]),
      )
      .mockReturnValueOnce(sel([{ monthly_words_quota: 300000 }]));
    const r = await service.payMockOrder('u1', 'o1');
    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'paid' }),
    );
    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({ monthly_words_quota: 300000 }),
    );
    expect(r.quota_words).toBe(300000);
  });

  it('已支付订单拒绝重复支付', async () => {
    mockDb.select.mockReturnValueOnce(
      sel([{ id: 'o1', status: 'paid', quota_words: 300000 }]),
    );
    await expect(service.payMockOrder('u1', 'o1')).rejects.toThrow(
      '订单已支付',
    );
  });

  it('他人订单不可支付', async () => {
    mockDb.select.mockReturnValueOnce(sel([]));
    await expect(
      service.payMockOrder('u1', 'someone-else-order'),
    ).rejects.toThrow('订单不存在');
  });
});
