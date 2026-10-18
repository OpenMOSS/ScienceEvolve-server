import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type GatewayHostnameResolver = (hostname: string) => Promise<readonly string[]>;

const privateGatewayIpv4 = new BlockList();
const blockedGatewayIpv4 = new BlockList();
const blockedGatewayIpv6 = new BlockList();
const publicIpv6Unicast = new BlockList();

for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16]
] as const) {
  privateGatewayIpv4.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  blockedGatewayIpv4.addSubnet(network, prefix, "ipv4");
}

publicIpv6Unicast.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:30::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fec0::", 10],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) {
  blockedGatewayIpv6.addSubnet(network, prefix, "ipv6");
}

function isPrivateGatewayIp(address: string): boolean {
  return isIP(address) === 4 && privateGatewayIpv4.check(address, "ipv4");
}

function isBlockedGatewayIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedGatewayIpv4.check(address, "ipv4");
  if (family !== 6) return true;
  return !publicIpv6Unicast.check(address, "ipv6") || blockedGatewayIpv6.check(address, "ipv6");
}

function canonicalHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

/** Validate and canonicalize the HTTPS URL stored for a gateway. */
export function validateGatewayUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("网关 URL 必须是有效的 HTTPS 地址");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("网关 URL 仅支持 HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("网关 URL 不允许携带用户信息、查询参数或片段");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error("网关 URL 仅允许 HTTPS 443 端口");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

const defaultResolver: GatewayHostnameResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

const DNS_NOT_FOUND_CODES = new Set(["ENODATA", "ENONAME", "ENOTFOUND", "NXDOMAIN"]);
const DNS_TRANSIENT_CODES = new Set(["EAI_AGAIN", "ESERVFAIL"]);
const DNS_TIMEOUT_CODES = new Set(["ETIMEDOUT", "ETIMEOUT"]);

function dnsErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim()
    ? code.trim().toUpperCase()
    : undefined;
}

function gatewayDnsResolutionError(hostname: string, error: unknown): Error {
  const code = dnsErrorCode(error);
  const codeSuffix = code ? `（${code}）` : "";
  if (code && DNS_NOT_FOUND_CODES.has(code)) {
    return new Error(`网关域名不存在或没有 A/AAAA 记录${codeSuffix}：${hostname}`);
  }
  if (code && DNS_TIMEOUT_CODES.has(code)) {
    return new Error(`网关域名 DNS 解析超时${codeSuffix}：${hostname}`);
  }
  if (code && DNS_TRANSIENT_CODES.has(code)) {
    return new Error(`网关域名 DNS 服务暂时不可用${codeSuffix}：${hostname}`);
  }
  return new Error(`网关域名 DNS 解析失败${codeSuffix}：${hostname}`);
}

/**
 * Resolve the gateway immediately before network access. Public and RFC1918
 * addresses are accepted. Loopback, link-local, CGNAT, metadata, multicast,
 * documentation, benchmark and mixed public/private answers remain blocked.
 */
export async function validateGatewayNetworkTarget(
  value: string,
  resolver: GatewayHostnameResolver = defaultResolver
): Promise<string> {
  return validateNetworkTarget(value, resolver, true);
}

/** Validate a public HTTPS destination used by server-side Web Fetch. */
export async function validatePublicWebNetworkTarget(
  value: string,
  resolver: GatewayHostnameResolver = defaultResolver
): Promise<string> {
  return validateNetworkTarget(value, resolver, false);
}

async function validateNetworkTarget(
  value: string,
  resolver: GatewayHostnameResolver,
  allowPrivate: boolean
): Promise<string> {
  const canonical = validateGatewayUrl(value);
  const hostname = canonicalHostname(new URL(canonical).hostname);
  let addresses: readonly string[];
  if (isIP(hostname) !== 0) {
    addresses = [hostname];
  } else {
    try {
      addresses = await resolver(hostname);
    } catch (error) {
      throw gatewayDnsResolutionError(hostname, error);
    }
  }
  if (!addresses.length) {
    throw new Error(`网关域名没有返回 A/AAAA 记录：${hostname}`);
  }
  if (addresses.some((address) => isIP(address) === 0)) {
    throw new Error(`网关 DNS 返回了无效的 IP 地址：${hostname}`);
  }
  const blockedAddress = addresses.find(isBlockedGatewayIp);
  if (blockedAddress) {
    throw new Error(`网关地址指向被禁止的本机、链路本地、元数据、CGNAT、组播或保留地址：${blockedAddress}`);
  }
  const privateAnswers = addresses.filter(isPrivateGatewayIp);
  if (!allowPrivate && privateAnswers.length) {
    throw new Error(`Web Fetch 地址不能指向内网：${privateAnswers[0]}`);
  }
  if (privateAnswers.length && privateAnswers.length !== addresses.length) {
    throw new Error("网关不能同时解析到公网和内网地址");
  }
  return canonical;
}
