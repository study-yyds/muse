/**
 * 用户自定义 API Key 的 base_url 安全校验（SSRF 防护）
 *
 * 拒绝规则：
 * - 非 http/https 协议
 * - 私网/回环/链路本地/云元数据/保留地址段（IPv4 + IPv6）
 * - localhost、*.local、*.internal 等本机/内网域名
 * - DNS 解析后任一地址落在被拒网段（防 DNS rebinding）
 *
 * 注：自建局域网 LLM（如 Ollama）会被拦截。如需支持，可后续
 * 通过环境变量 ALLOWED_PRIVATE_BASE_URLS 加白名单。
 */
import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** 被拒 IPv4 网段：[起始整数, 结束整数] */
const IPV4_BLOCKED_RANGES: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8 "this network"
  [0x0a000000, 0x0affffff], // 10.0.0.0/8 私网
  [0x64400000, 0x647fffff], // 100.64.0.0/10 CGNAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 回环
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 链路本地(含云元数据)
  [0xac100000, 0xac1fffff], // 172.16.0.0/12 私网
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24 IETF 协议保留
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24 TEST-NET-1
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16 私网
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 基准测试
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 0xefffffff], // 224.0.0.0/4 组播
  [0xf0000000, 0xffffffff], // 240.0.0.0/4 保留
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** 判断 IP 是否属于被拒网段（私网/回环/链路本地/保留等） */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const n = ipv4ToInt(ip);
    if (n === null) return true; // 非法 IPv4 一律拒绝
    return IPV4_BLOCKED_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    // IPv4 映射地址：检查内嵌的 IPv4
    if (lower.startsWith('::ffff:')) {
      return isBlockedIp(lower.slice(7));
    }
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') || // fc00::/7 唯一本地地址
      lower.startsWith('fd') ||
      lower.startsWith('fe8') || // fe80::/10 链路本地
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower.startsWith('ff') // 组播
    );
  }
  return true; // 非 IPv4/IPv6 一律拒绝
}

function checkUrlSync(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BadRequestException('base_url 格式无效');
  }
  const proto = url.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') {
    throw new BadRequestException('base_url 仅支持 http/https 协议');
  }
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (!host) {
    throw new BadRequestException('base_url 缺少主机名');
  }
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new BadRequestException('base_url 不允许指向内网地址');
    }
    return url;
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new BadRequestException('base_url 不允许指向本机/内网域名');
  }
  return url;
}

/** 同步校验：仅检查 URL 形态与 IP 字面量（存储 API Key 时使用） */
export function assertSafeBaseUrlSync(rawUrl: string): URL {
  return checkUrlSync(rawUrl);
}

/** 异步校验：同步检查 + DNS 解析结果复查（发起上游请求前使用） */
export async function assertSafeBaseUrl(rawUrl: string): Promise<URL> {
  const url = checkUrlSync(rawUrl);
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (!isIP(host)) {
    let addrs: Array<{ address: string }>;
    try {
      addrs = await lookup(host, { all: true });
    } catch {
      throw new BadRequestException('base_url 域名无法解析');
    }
    if (addrs.some((a) => isBlockedIp(a.address))) {
      throw new BadRequestException('base_url 域名解析到内网地址');
    }
  }
  return url;
}
