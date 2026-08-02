import { encryptPhone, decryptPhone } from './crypto.util';

describe('crypto.util', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'dd9aef324fccb234761a45e07acb3453701ad94d5d9f6ec7c9f445fc767bc24b';
  });

  describe('encryptPhone + decryptPhone roundtrip', () => {
    it('加密后解密得到原文', () => {
      const phone = '13800138000';
      const encrypted = encryptPhone(phone);
      expect(encrypted).not.toBe(phone);
      expect(decryptPhone(encrypted)).toBe(phone);
    });

    it('不同加密产生不同密文（IV 随机）', () => {
      const phone = '13800138000';
      const a = encryptPhone(phone);
      const b = encryptPhone(phone);
      expect(a).not.toBe(b);
    });

    it('中文和其他字符支持', () => {
      const inputs = ['测试用户', 'user@test.com', '+86-13800138000'];
      for (const input of inputs) {
        expect(decryptPhone(encryptPhone(input))).toBe(input);
      }
    });

    it('空字符串', () => {
      expect(decryptPhone(encryptPhone(''))).toBe('');
    });
  });

  describe('decryptPhone 错误处理', () => {
    it('篡改密文导致解密失败', () => {
      const encrypted = encryptPhone('13800138000');
      const tampered = encrypted.slice(0, -4) + 'XXXX';
      expect(() => decryptPhone(tampered)).toThrow();
    });

    it('无效 base64 输入抛错', () => {
      expect(() => decryptPhone('not-valid-base64!!!')).toThrow();
    });

    it('过短的密文抛错', () => {
      expect(() => decryptPhone('YWJj')).toThrow();
    });
  });

  describe('密钥', () => {
    it('未设置 ENCRYPTION_KEY 抛错', () => {
      const original = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      expect(() => encryptPhone('13800138000')).toThrow('ENCRYPTION_KEY 环境变量未设置');
      process.env.ENCRYPTION_KEY = original;
    });
  });
});
