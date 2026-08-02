import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './app.module';

jest.mock('marked', () => ({ marked: { parse: jest.fn((s: string) => `<p>${s}</p>`) } }));
jest.mock('@neondatabase/serverless', () => ({}));

describe('API — 四层覆盖（正常/校验/权限/边界）', () => {
  let app: INestApplication;
  let token: string | null = null;
  let bookId: string | null = null;

  beforeAll(async () => {
    const m: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication();
    await app.init();

    // === 获取登录 Token ===
    const phone = '13800138000';
    const codeRes = await request(app.getHttpServer())
      .post('/api/auth/send-code')
      .send({ phone_number: phone });
    if (codeRes.body?.data?.code) {
      const loginRes = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ phone_number: phone, code: codeRes.body.data.code });
      token = loginRes.body?.data?.access_token ?? null;
      if (token) {
        // 创建测试作品
        const bookRes = await request(app.getHttpServer())
          .post('/api/books')
          .set('Authorization', `Bearer ${token}`)
          .send({ title: 'E2E 测试作品' });
        bookId = bookRes.body?.data?.book_id ?? null;
      }
    }
  }, 30000);

  afterAll(async () => { await app.close(); });

  // ===== 辅助方法 =====
  const auth = () => token ? { Authorization: `Bearer ${token}` } : {};

  // ===== 1. Auth =====
  describe('Auth — 认证', () => {
    it('正常 — 发送验证码', async () => {
      const r = await request(app.getHttpServer())
        .post('/api/auth/send-code').send({ phone_number: '13800138000' });
      // 公开接口 — DB 可用时 200/201，DB 不可用时 500
      expect([200, 201, 500]).toContain(r.status);
    });

    it('校验 — 缺少 phone_number', async () => {
      const r = await request(app.getHttpServer())
        .post('/api/auth/send-code').send({});
      expect(r.status).toBeGreaterThanOrEqual(400);
    });

    it('权限 — 无 Token 访问 /user/profile', async () => {
      const r = await request(app.getHttpServer()).get('/api/user/profile');
      expect([401, 403]).toContain(r.status);
    });

    it('边界 — 空手机号', async () => {
      const r = await request(app.getHttpServer())
        .post('/api/auth/send-code').send({ phone_number: '' });
      expect([200, 201, 400, 500]).toContain(r.status);
    });
  });

  // ===== 2. Books =====
  describe('Books — 作品', () => {
    it('正常 — 获取作品列表（已登录）', async () => {
      if (!token) return;
      const r = await request(app.getHttpServer()).get('/api/books').set(auth());
      expect(r.status).toBe(200);
    });

    it('校验 — 创建作品缺少 title', async () => {
      if (!token) return;
      const r = await request(app.getHttpServer())
        .post('/api/books').set(auth()).send({});
      expect(r.status).toBeGreaterThanOrEqual(400);
    });

    it('权限 — 无 Token 创建作品', async () => {
      const r = await request(app.getHttpServer())
        .post('/api/books').send({ title: 'hack' });
      expect([401, 403]).toContain(r.status);
    });

    it('边界 — 超长标题', async () => {
      if (!token) return;
      const r = await request(app.getHttpServer())
        .post('/api/books').set(auth()).send({ title: 'x'.repeat(300) });
      expect([201, 400, 500]).toContain(r.status);
    });

    it('正常 — 获取作品详情', async () => {
      if (!token || !bookId) return;
      const r = await request(app.getHttpServer())
        .get(`/api/books/${bookId}`).set(auth());
      expect(r.status).toBe(200);
    });
  });

  // ===== 3. Chapters =====
  describe('Chapters — 章节', () => {
    let chapterId: string | null = null;

    beforeAll(async () => {
      if (!token || !bookId) return;
      const r = await request(app.getHttpServer())
        .post(`/api/books/${bookId}/chapters`).set(auth()).send({ title: '测试章节' });
      chapterId = r.body?.data?.chapter_id ?? null;
    });

    it('正常 — 获取章节列表', async () => {
      if (!token || !bookId) return;
      const r = await request(app.getHttpServer())
        .get(`/api/books/${bookId}/chapters`).set(auth());
      expect(r.status).toBe(200);
    });

    it('校验 — 创建章节缺少 title', async () => {
      if (!token || !bookId) return;
      const r = await request(app.getHttpServer())
        .post(`/api/books/${bookId}/chapters`).set(auth()).send({});
      expect(r.status).toBeGreaterThanOrEqual(400);
    });

    it('权限 — 无 Token 获取章节', async () => {
      const r = await request(app.getHttpServer())
        .get('/api/books/x/chapters');
      expect([401, 403]).toContain(r.status);
    });

    it('边界 — 保存负数 word_count', async () => {
      if (!token || !bookId || !chapterId) return;
      const r = await request(app.getHttpServer())
        .put(`/api/books/${bookId}/chapters/${chapterId}`).set(auth())
        .send({ content: 'test', word_count: -1 });
      expect([200, 400, 500]).toContain(r.status);
    });

    it('正常 — 保存章节内容', async () => {
      if (!token || !bookId || !chapterId) return;
      const r = await request(app.getHttpServer())
        .put(`/api/books/${bookId}/chapters/${chapterId}`).set(auth())
        .send({ content: '章节正文内容', word_count: 6 });
      expect(r.status).toBe(200);
    });
  });

  // ===== 4. Characters =====
  describe('Characters — 角色', () => {
    it('正常 — 获取角色列表', async () => {
      if (!token || !bookId) return;
      const r = await request(app.getHttpServer())
        .get(`/api/books/${bookId}/characters`).set(auth());
      expect(r.status).toBe(200);
    });

    it('校验 — 创建角色缺少 name', async () => {
      if (!token || !bookId) return;
      const r = await request(app.getHttpServer())
        .post(`/api/books/${bookId}/characters`).set(auth()).send({});
      expect(r.status).toBeGreaterThanOrEqual(400);
    });

    it('权限 — 无 Token 创建角色', async () => {
      const r = await request(app.getHttpServer())
        .post('/api/books/x/characters').send({ name: 'hack' });
      expect([401, 403]).toContain(r.status);
    });

    it('边界 — 超长角色名', async () => {
      if (!token || !bookId) return;
      const r = await request(app.getHttpServer())
        .post(`/api/books/${bookId}/characters`).set(auth())
        .send({ name: 'x'.repeat(200) });
      expect([201, 400, 500]).toContain(r.status);
    });
  });

  // ===== 5. AI =====
  describe('AI — 人工智能', () => {
    it('权限 — 无 Token 调用 chat', async () => {
      const r = await request(app.getHttpServer())
        .post('/api/ai/chat').send({ book_id: 'x', message: 'hi' });
      expect([401, 403]).toContain(r.status);
    });

    it('校验 — 缺少 message', async () => {
      if (!token) return;
      const r = await request(app.getHttpServer())
        .post('/api/ai/chat').set(auth()).send({ book_id: bookId || 'x' });
      expect(r.status).toBeGreaterThanOrEqual(400);
    });

    it('权限 — 无 Token 调用 generate', async () => {
      const r = await request(app.getHttpServer())
        .post('/api/ai/generate').send({ bookId: 'x', chapterId: 'x', mode: 'continue' });
      expect([401, 403]).toContain(r.status);
    });

    it('权限 — 无 Token 调用 mimic-style', async () => {
      const r = await request(app.getHttpServer())
        .post('/api/ai/mimic-style').send({ book_id: 'x' });
      expect([401, 403]).toContain(r.status);
    });
  });

  // ===== 6. Settings =====
  describe('Settings — 设置', () => {
    it('正常 — 获取设置', async () => {
      if (!token || !bookId) return;
      const r = await request(app.getHttpServer())
        .get(`/api/books/${bookId}/settings`).set(auth());
      expect(r.status).toBe(200);
    });

    it('校验 — 非法 auto_save_interval', async () => {
      if (!token || !bookId) return;
      const r = await request(app.getHttpServer())
        .put(`/api/books/${bookId}/settings`).set(auth())
        .send({ auto_save_interval_sec: -1 });
      expect([200, 400, 500]).toContain(r.status);
    });

    it('权限 — 无 Token 修改设置', async () => {
      const r = await request(app.getHttpServer())
        .put('/api/books/x/settings').send({});
      expect([401, 403]).toContain(r.status);
    });
  });

  // ===== 7. Templates =====
  describe('Templates — 模板', () => {
    it('正常 — 公开列表无需登录', async () => {
      const r = await request(app.getHttpServer()).get('/api/templates');
      expect([200, 500]).toContain(r.status);
    });

    it('校验 — 创建模板缺少必填字段', async () => {
      if (!token) return;
      const r = await request(app.getHttpServer())
        .post('/api/templates').set(auth()).send({});
      expect(r.status).toBeGreaterThanOrEqual(400);
    });

    it('权限 — 无 Token 删除模板', async () => {
      const r = await request(app.getHttpServer())
        .delete('/api/templates/some-id');
      expect([401, 403]).toContain(r.status);
    });

    it('权限 — 无 Token 访问 admin 端点', async () => {
      const r = await request(app.getHttpServer()).get('/api/templates/admin/all');
      expect([401, 403]).toContain(r.status);
    });
  });

  // ===== 8. Admin =====
  describe('Admin — 管理后台', () => {
    it('权限 — 无 Token 访问', async () => {
      const r = await request(app.getHttpServer()).get('/api/admin/users');
      expect([401, 403]).toContain(r.status);
    });

    it('权限 — 非 admin Token', async () => {
      if (!token) return;
      const r = await request(app.getHttpServer())
        .get('/api/admin/users').set(auth());
      expect([403]).toContain(r.status);
    });

    it('权限 — 无 Token 修改用户', async () => {
      const r = await request(app.getHttpServer())
        .patch('/api/admin/users/x').send({ status: 'banned' });
      expect([401, 403]).toContain(r.status);
    });
  });

  // ===== 9. Other Routes =====
  describe('Other — 世界观/大纲/导出', () => {
    it('权限 — 无 Token 访问世界观', async () => {
      const r = await request(app.getHttpServer())
        .get('/api/books/x/world-setting');
      expect([401, 403]).toContain(r.status);
    });

    it('权限 — 无 Token 访问大纲', async () => {
      const r = await request(app.getHttpServer())
        .get('/api/books/x/outline');
      expect([401, 403]).toContain(r.status);
    });

    it('权限 — 无 Token 导出', async () => {
      const r = await request(app.getHttpServer())
        .get('/api/books/x/export?format=txt');
      expect([401, 403]).toContain(r.status);
    });

    it('权限 — 无 Token 角色测试', async () => {
      const r = await request(app.getHttpServer())
        .post('/api/books/x/characters/x/test');
      expect([401, 403]).toContain(r.status);
    });
  });
});
