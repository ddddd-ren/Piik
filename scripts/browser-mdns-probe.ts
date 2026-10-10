import { mkdtemp } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CdpConnection, cleanupRun, createPage, evaluate, launchChrome, reservePort,
  waitForVersion, type CleanupResources,
} from "./browser-gate-harness";

export function probeOrigin(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("请提供 HTTPS 来源或本机 HTTP 来源，不含凭据、路径、查询和片段");
  }
  return url.origin;
}

export function summarizeCandidates(candidates: string[]) {
  const host = candidates.filter((candidate) => /\styp host(?:\s|$)/u.test(candidate));
  const addresses = host.map((candidate) => candidate.trim().split(/\s+/u)[4] ?? "");
  return {
    total: candidates.length,
    host: host.length,
    mdns: addresses.filter((address) => address.toLowerCase().endsWith(".local")).length,
    realIp: addresses.filter((address) => isIP(address) !== 0).length,
  };
}

const probe = String.raw`(async () => {
  const pc = new RTCPeerConnection();
  const candidates = [];
  pc.onicecandidate = (event) => {
    if (event.candidate) candidates.push(event.candidate.candidate);
  };
  try {
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    const complete = await new Promise((resolve) => {
      let timer;
      const finish = (value) => { clearTimeout(timer); resolve(value); };
      timer = setTimeout(() => finish(false), 6000);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') finish(true);
      };
      if (pc.iceGatheringState === 'complete') finish(true);
    });
    return { origin: location.origin, candidates, complete };
  } finally {
    pc.close();
  }
})()`;

async function main() {
  if (process.argv.length !== 3 || !process.env.CHROME_PATH) {
    throw new Error("设置 CHROME_PATH 后运行 npm exec -- tsx scripts/browser-mdns-probe.ts <站点来源>");
  }
  const origin = probeOrigin(process.argv[2]!);
  const resources: CleanupResources = {
    cdp: null, chrome: null, native: null, server: null, profile: null, ports: [],
  };
  try {
    const port = await reservePort();
    resources.ports.push(port);
    resources.profile = await mkdtemp(join(tmpdir(), "piik-client-loopback-"));
    resources.chrome = await launchChrome(process.env.CHROME_PATH, port, resources.profile,
      ["--headless=new", "--no-first-run", "--no-default-browser-check"]);
    resources.chrome.stdout.resume();
    resources.chrome.stderr.resume();
    const version = await waitForVersion(port, resources.chrome);
    resources.cdp = await CdpConnection.connect(version.webSocketDebuggerUrl, Date.now() + 5000);
    for (const url of ["about:blank", origin]) {
      const page = await createPage(resources.cdp, url);
      const result = await evaluate<{
        origin: string; candidates: string[]; complete: boolean;
      }>(resources.cdp, page, probe, Date.now() + 10_000);
      if (result.origin !== (url === "about:blank" ? "null" : origin)) {
        throw new Error("页面来源不匹配，请检查重定向；此结果不能作为目标站点的证据");
      }
      const summary = summarizeCandidates(result.candidates);
      console.log(JSON.stringify({ browser: version.Browser, page: url,
        complete: result.complete, ...summary }));
      if (!result.complete || summary.host === 0) {
        throw new Error("候选收集超时或没有 host 候选，不能判断 mDNS 豁免是否生效");
      }
    }
  } finally {
    const cleanup = await cleanupRun(resources);
    if (Object.values(cleanup).some((complete) => !complete)) {
      console.error("浏览器或临时配置清理未完成", cleanup);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "浏览器候选探测失败");
    process.exitCode = 1;
  });
}
