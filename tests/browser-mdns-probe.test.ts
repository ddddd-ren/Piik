import { expect, it } from "vitest";
import { probeOrigin, summarizeCandidates } from "../scripts/browser-mdns-probe";

it("统计候选地址字段，区分 IPv4、IPv6、mDNS 和其他候选", () => {
  const candidate = (address: string, type = "host") =>
    `candidate:1 1 udp 2122260223 ${address} 58932 typ ${type}`;
  expect(summarizeCandidates([
    candidate("192.0.2.1"), candidate("2001:db8::1"), candidate("uuid.local"),
    candidate("999.1.2.3"), candidate("192.0.2.2", "srflx"),
    candidate("uuid.local") + " raddr 192.0.2.3 rport 1234",
  ])).toEqual({ total: 6, host: 5, mdns: 2, realIp: 2 });
  expect(summarizeCandidates([])).toEqual({ total: 0, host: 0, mdns: 0, realIp: 0 });
});

it("仅接受安全来源，阻止凭据或导航地址进入诊断输出", () => {
  for (const value of ["https://piik.example.com", "http://localhost:8787",
    "http://127.0.0.1:8787", "http://[::1]:8787"]) {
    expect(probeOrigin(value)).toBe(value);
  }
  for (const value of ["https://user:secret@piik.example.com", "https://piik.example.com/path",
    "https://piik.example.com/?token=secret", "https://piik.example.com/#secret",
    "http://piik.example.com", "javascript:alert(1)", "invalid"]) {
    expect(() => probeOrigin(value)).toThrow();
  }
});
