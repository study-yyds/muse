import {
  assertSafeBaseUrlSync,
  assertSafeBaseUrl,
  isBlockedIp,
} from './base-url-safety';
import { BadRequestException } from '@nestjs/common';

// Mock DNS：默认解析为公网 IP；按测试需要可覆盖为私网 IP
const mockLookup = jest.fn().mockResolvedValue([{ address: '93.184.216.34' }]);
jest.mock('node:dns/promises', () => ({
  lookup: (...args: any[]) => mockLookup(...args),
}));

describe('base-url-safety（SSRF 防护）', () => {
  describe('isBlockedIp', () => {
    it.each([
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // 云元数据
      '0.0.0.0',
      '224.0.0.1',
      '100.64.0.1',
      '::1',
      '::',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:10.0.0.1', // IPv4 映射
    ])('拒绝内网/保留地址 %s', (ip) => {
      expect(isBlockedIp(ip)).toBe(true);
    });

    it.each(['8.8.8.8', '93.184.216.34', '2400:3200::1'])(
      '放行公网地址 %s',
      (ip) => {
        expect(isBlockedIp(ip)).toBe(false);
      },
    );
  });

  describe('assertSafeBaseUrlSync', () => {
    it('放行合法的 https 公网地址', () => {
      expect(() =>
        assertSafeBaseUrlSync('https://api.deepseek.com/v1'),
      ).not.toThrow();
    });

    it('放行 http 协议', () => {
      expect(() =>
        assertSafeBaseUrlSync('http://api.example.com'),
      ).not.toThrow();
    });

    it('拒绝非 http/https 协议', () => {
      expect(() => assertSafeBaseUrlSync('ftp://api.example.com')).toThrow(
        BadRequestException,
      );
      expect(() => assertSafeBaseUrlSync('file:///etc/passwd')).toThrow(
        BadRequestException,
      );
    });

    it('拒绝格式非法的字符串', () => {
      expect(() => assertSafeBaseUrlSync('not-a-url')).toThrow(
        BadRequestException,
      );
    });

    it('拒绝私网 IP 字面量', () => {
      expect(() => assertSafeBaseUrlSync('http://192.168.1.1:8080/v1')).toThrow(
        BadRequestException,
      );
      expect(() =>
        assertSafeBaseUrlSync('http://169.254.169.254/latest/meta-data'),
      ).toThrow(BadRequestException);
    });

    it('拒绝 localhost 与内网域名', () => {
      expect(() => assertSafeBaseUrlSync('http://localhost:11434/v1')).toThrow(
        BadRequestException,
      );
      expect(() => assertSafeBaseUrlSync('http://myhost.local/v1')).toThrow(
        BadRequestException,
      );
      expect(() => assertSafeBaseUrlSync('http://db.internal/v1')).toThrow(
        BadRequestException,
      );
    });
  });

  describe('assertSafeBaseUrl（含 DNS 复查）', () => {
    it('域名解析到公网 IP 时放行', async () => {
      mockLookup.mockResolvedValue([{ address: '8.8.8.8' }]);
      await expect(
        assertSafeBaseUrl('https://api.example.com/v1'),
      ).resolves.toBeTruthy();
    });

    it('域名解析到私网 IP 时拒绝（防 DNS rebinding）', async () => {
      mockLookup.mockResolvedValue([{ address: '10.0.0.1' }]);
      await expect(
        assertSafeBaseUrl('https://api.example.com/v1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('域名无法解析时拒绝（fail closed）', async () => {
      mockLookup.mockRejectedValue(new Error('NXDOMAIN'));
      await expect(
        assertSafeBaseUrl('https://no-such-host.invalid/v1'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
