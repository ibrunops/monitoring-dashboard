import express, { type Response } from 'express';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import si from 'systeminformation';

type HistoryWindowKey = '5m' | '30m' | '1h';

type LiveMetrics = {
  timestamp: number;
  cpuUsage: number;
  cpuTempC: number | null;
  load1: number;
  load5: number;
  load15: number;
  memoryUsedPercent: number;
  memoryUsedGb: number;
  memoryTotalGb: number;
  diskUsedPercent: number;
  diskUsedGb: number;
  diskTotalGb: number;
  networkRxKBps: number;
  networkTxKBps: number;
};

type ListenerScope = 'loopback' | 'private' | 'all-interfaces' | 'public-ip' | 'unknown';
type ListenerExposure = 'loopback' | 'private-network' | 'wide-network' | 'public-hint' | 'unknown';
type ListenerSeverity = 'low' | 'medium' | 'high';

type ListeningPort = {
  id: string;
  protocol: string;
  port: string;
  binds: string[];
  bindLabel: string;
  process: string;
  scope: ListenerScope;
  exposure: ListenerExposure;
  severity: ListenerSeverity;
  sensitive: boolean;
  networkReachable: boolean;
  notes: string;
};

type HostSnapshot = {
  hostname: string;
  platform: string;
  distro: string;
  release: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  uptimeSeconds: number;
  primaryIp: string | null;
  nodeVersion: string;
};

type SecuritySnapshot = {
  firewall: {
    active: boolean | null;
    provider: string | null;
    detail: string;
  };
  ssh: {
    active: boolean;
    networkBound: boolean;
    detail: string;
  };
  listeningPorts: ListeningPort[];
  networkPortCount: number;
  highRiskPortCount: number;
  mediumRiskPortCount: number;
  posture: {
    score: number;
    level: 'healthy' | 'watch' | 'hot';
    label: string;
    summary: string;
  };
};

type ServiceSnapshot = {
  openclaw: {
    installed: boolean;
    version: string | null;
    gatewayActive: boolean | null;
    detail: string;
  };
  topProcesses: Array<{
    pid: number;
    name: string;
    cpu: number;
    memoryMb: number;
    memoryPercent: number;
  }>;
};

type DashboardPayload = {
  generatedAt: string;
  staticCollectedAt: string;
  historyWindow: HistoryWindowKey;
  host: HostSnapshot;
  live: LiveMetrics;
  history: LiveMetrics[];
  security: SecuritySnapshot;
  services: ServiceSnapshot;
};

const HISTORY_WINDOW_MS: Record<HistoryWindowKey, number> = {
  '5m': 5 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
};

const DEFAULT_HISTORY_WINDOW: HistoryWindowKey = '5m';
const SAMPLE_INTERVAL_MS = 2_000;
const STATIC_CACHE_MS = 60_000;
const HISTORY_RETENTION_SAMPLES = Math.ceil(HISTORY_WINDOW_MS['1h'] / SAMPLE_INTERVAL_MS) + 30;
const SENSITIVE_PORTS = new Set(['22', '2375', '2376', '3306', '3389', '5432', '5900', '6379', '9200', '27017']);

const app = express();
const port = Number(process.env.PORT ?? 4318);
const host = process.env.HOST ?? '127.0.0.1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../client');

const history: LiveMetrics[] = [];
let latestLive: LiveMetrics | null = null;
let sampleInFlight = false;
const streamClients = new Map<Response, HistoryWindowKey>();
let staticCache:
  | {
      expiresAt: number;
      payload: Omit<DashboardPayload, 'generatedAt' | 'historyWindow' | 'live' | 'history'>;
    }
  | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function bytesToGb(bytes: number): number {
  return round(bytes / 1024 ** 3, 2);
}

function bytesToMb(bytes: number): number {
  return round(bytes / 1024 ** 2, 1);
}

function normalizeProcessRss(value: number): number {
  return value * 1024;
}

function pushHistory(sample: LiveMetrics): void {
  history.push(sample);
  if (history.length > HISTORY_RETENTION_SAMPLES) {
    history.shift();
  }
}

function runCommand(command: string, args: string[], timeout = 3000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout, maxBuffer: 512 * 1024, encoding: 'utf8' },
      (_error, stdout, stderr) => {
        resolve(`${stdout}${stderr}`.trim());
      },
    );
  });
}

function runShell(script: string, timeout = 3000): Promise<string> {
  return runCommand('bash', ['-lc', script], timeout);
}

function parseHistoryWindow(value: unknown): HistoryWindowKey {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === '30m' || candidate === '1h' || candidate === '5m'
    ? candidate
    : DEFAULT_HISTORY_WINDOW;
}

function selectHistory(windowKey: HistoryWindowKey): LiveMetrics[] {
  const anchor = latestLive?.timestamp ?? Date.now();
  const cutoff = anchor - HISTORY_WINDOW_MS[windowKey];
  return history.filter((sample) => sample.timestamp >= cutoff);
}

function extractPort(bind: string): string {
  const bracketed = bind.match(/\]:(\d+|\*)$/);
  if (bracketed?.[1]) {
    return bracketed[1];
  }

  const lastColon = bind.lastIndexOf(':');
  return lastColon >= 0 ? bind.slice(lastColon + 1) : bind;
}

function extractHost(bind: string): string {
  if (bind.startsWith('[')) {
    const closing = bind.indexOf(']');
    return closing >= 0 ? bind.slice(1, closing) : bind;
  }

  const lastColon = bind.lastIndexOf(':');
  return lastColon >= 0 ? bind.slice(0, lastColon) : bind;
}

function normalizeHost(hostName: string): string {
  return hostName.trim().toLowerCase().split('%')[0] ?? hostName.trim().toLowerCase();
}

function isLoopbackIPv4(hostName: string): boolean {
  return hostName.startsWith('127.');
}

function isLoopbackIPv6(hostName: string): boolean {
  return hostName === '::1' || hostName === '0:0:0:0:0:0:0:1';
}

function isPrivateIPv4(hostName: string): boolean {
  return (
    hostName.startsWith('10.') ||
    hostName.startsWith('169.254.') ||
    hostName.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostName)
  );
}

function isPrivateIPv6(hostName: string): boolean {
  return hostName.startsWith('fc') || hostName.startsWith('fd') || hostName.startsWith('fe80:');
}

function classifyBindScope(bind: string): ListenerScope {
  const hostName = normalizeHost(extractHost(bind));

  if (!hostName || hostName === '*' || hostName === '0.0.0.0' || hostName === '::') {
    return 'all-interfaces';
  }

  if (hostName === 'localhost' || isLoopbackIPv4(hostName) || isLoopbackIPv6(hostName)) {
    return 'loopback';
  }

  if (hostName.includes(':')) {
    return isPrivateIPv6(hostName) ? 'private' : 'public-ip';
  }

  if (isPrivateIPv4(hostName)) {
    return 'private';
  }

  return /^\d+\.\d+\.\d+\.\d+$/.test(hostName) ? 'public-ip' : 'unknown';
}

function toExposure(scope: ListenerScope): ListenerExposure {
  switch (scope) {
    case 'loopback':
      return 'loopback';
    case 'private':
      return 'private-network';
    case 'all-interfaces':
      return 'wide-network';
    case 'public-ip':
      return 'public-hint';
    default:
      return 'unknown';
  }
}

function isNetworkReachableScope(scope: ListenerScope): boolean {
  return scope === 'private' || scope === 'all-interfaces' || scope === 'public-ip';
}

function getPortSeverity(scope: ListenerScope, portNumber: string): ListenerSeverity {
  const sensitive = SENSITIVE_PORTS.has(portNumber);

  if (scope === 'loopback') {
    return 'low';
  }

  if (scope === 'private') {
    return sensitive ? 'medium' : 'low';
  }

  if (scope === 'all-interfaces' || scope === 'public-ip') {
    return sensitive ? 'high' : 'medium';
  }

  return sensitive ? 'medium' : 'low';
}

function describeListenerNotes(scope: ListenerScope, portNumber: string, sensitive: boolean): string {
  if (scope === 'loopback') {
    return 'Solo visible desde el propio host.';
  }

  if (scope === 'private') {
    return sensitive
      ? `Escucha en red privada sobre el puerto ${portNumber}. Conviene validar segmentación y necesidad.`
      : 'Escucha en red privada. Revisar si realmente debe salir de loopback.';
  }

  if (scope === 'all-interfaces') {
    return sensitive
      ? `Escucha en todas las interfaces sobre el puerto ${portNumber}. Revisar firewall, proxy inverso o NSG.`
      : 'Escucha amplia en el host. Conviene confirmar que sea intencional.';
  }

  if (scope === 'public-ip') {
    return sensitive
      ? `Se detectó bind directo sobre IP pública para el puerto ${portNumber}. Prioridad alta de revisión.`
      : 'El bind apunta a una IP pública concreta. Revisar exposición real.';
  }

  return 'El alcance del listener no es concluyente desde esta señal local.';
}

function summarizeBinds(binds: string[]): string {
  if (binds.length <= 2) {
    return binds.join(', ');
  }

  return `${binds[0]}, ${binds[1]} +${binds.length - 2}`;
}

function extractProcessLabel(detail: string): string {
  const quoted = detail.match(/"([^"]+)"/);
  if (quoted?.[1]) {
    return quoted[1];
  }

  const firstToken = detail.split(/\s+/)[0] ?? '';
  if (!firstToken || firstToken === 'sin') {
    return 'sin detalles';
  }

  return firstToken.includes('/') ? path.basename(firstToken) : firstToken;
}

function severityWeight(severity: ListenerSeverity): number {
  switch (severity) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    default:
      return 1;
  }
}

async function collectListeningPorts(): Promise<ListeningPort[]> {
  const output = await runShell('ss -tulpnH 2>/dev/null || true', 4000);
  const groups = new Map<
    string,
    {
      protocol: string;
      port: string;
      process: string;
      scope: ListenerScope;
      exposure: ListenerExposure;
      severity: ListenerSeverity;
      sensitive: boolean;
      networkReachable: boolean;
      notes: string;
      binds: Set<string>;
    }
  >();

  for (const line of output.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    const parts = line.split(/\s+/);
    const protocol = parts[0] ?? 'tcp';
    const bind = parts[4] ?? parts[3] ?? 'unknown';
    const processDetail = parts.slice(6).join(' ') || 'sin detalles';
    const scope = classifyBindScope(bind);
    const portNumber = extractPort(bind);
    const sensitive = SENSITIVE_PORTS.has(portNumber);
    const severity = getPortSeverity(scope, portNumber);
    const process = extractProcessLabel(processDetail);
    const key = [protocol, portNumber, process, scope].join('|');

    if (!groups.has(key)) {
      groups.set(key, {
        protocol,
        port: portNumber,
        process,
        scope,
        exposure: toExposure(scope),
        severity,
        sensitive,
        networkReachable: isNetworkReachableScope(scope),
        notes: describeListenerNotes(scope, portNumber, sensitive),
        binds: new Set<string>(),
      });
    }

    groups.get(key)?.binds.add(bind);
  }

  return [...groups.entries()]
    .map(([key, item]) => {
      const binds = [...item.binds].sort((left, right) => left.localeCompare(right));
      return {
        id: key,
        protocol: item.protocol,
        port: item.port,
        binds,
        bindLabel: summarizeBinds(binds),
        process: item.process,
        scope: item.scope,
        exposure: item.exposure,
        severity: item.severity,
        sensitive: item.sensitive,
        networkReachable: item.networkReachable,
        notes: item.notes,
      } satisfies ListeningPort;
    })
    .sort((left, right) => {
      const severityDelta = severityWeight(right.severity) - severityWeight(left.severity);
      if (severityDelta !== 0) {
        return severityDelta;
      }

      const reachabilityDelta = Number(right.networkReachable) - Number(left.networkReachable);
      if (reachabilityDelta !== 0) {
        return reachabilityDelta;
      }

      const portDelta = Number(left.port) - Number(right.port);
      if (!Number.isNaN(portDelta) && portDelta !== 0) {
        return portDelta;
      }

      return left.process.localeCompare(right.process);
    });
}

async function detectFirewall(): Promise<SecuritySnapshot['firewall']> {
  const ufw = await runShell('command -v ufw >/dev/null 2>&1 && ufw status || true');
  const ufwText = ufw.toLowerCase();

  if (ufwText.includes('status: active')) {
    return { active: true, provider: 'ufw', detail: 'UFW activo' };
  }

  if (ufwText.includes('status: inactive')) {
    return { active: false, provider: 'ufw', detail: 'UFW inactivo' };
  }

  const firewalld = await runShell('command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state || true');
  const firewalldText = firewalld.toLowerCase();

  if (firewalldText.includes('running')) {
    return { active: true, provider: 'firewalld', detail: 'firewalld activo' };
  }

  if (firewalldText.includes('not running')) {
    return { active: false, provider: 'firewalld', detail: 'firewalld detenido' };
  }

  return {
    active: null,
    provider: null,
    detail: 'No se detectó UFW ni firewalld desde este entorno',
  };
}

async function detectOpenClaw(): Promise<ServiceSnapshot['openclaw']> {
  const versionOutput = await runShell(
    [
      'export PATH="$HOME/.npm-global/bin:$HOME/bin:/usr/local/bin:/usr/bin:$PATH"',
      'if command -v openclaw >/dev/null 2>&1; then',
      '  openclaw --version 2>/dev/null',
      'elif [ -x "$HOME/.npm-global/bin/openclaw" ]; then',
      '  "$HOME/.npm-global/bin/openclaw" --version 2>/dev/null',
      'elif [ -x "/usr/local/bin/openclaw" ]; then',
      '  /usr/local/bin/openclaw --version 2>/dev/null',
      'else',
      '  true',
      'fi',
    ].join('\n'),
    4000,
  );
  const versionMatch = versionOutput.match(/OpenClaw\s+([^\s]+)/i);
  const version = versionMatch?.[1] ?? null;

  const statusOutput = await runShell(
    [
      'systemctl is-active openclaw-gateway.service 2>/dev/null || true',
      'systemctl --user is-active openclaw-gateway.service 2>/dev/null || true',
      "pgrep -af 'openclaw.*gateway|gateway.*openclaw' || true",
    ].join('\n'),
    4000,
  );
  const gatewayActive = /(^|\n)active($|\n)/i.test(statusOutput) || /openclaw.*gateway|gateway.*openclaw/i.test(statusOutput);
  const serviceKnown = /(^|\n)(inactive|failed)($|\n)/i.test(statusOutput);
  const installed = Boolean(version) || gatewayActive || serviceKnown || /openclaw/i.test(statusOutput);

  if (gatewayActive && version) {
    return {
      installed: true,
      version,
      gatewayActive: true,
      detail: `CLI ${version} y gateway activos`,
    };
  }

  if (gatewayActive) {
    return {
      installed: true,
      version,
      gatewayActive: true,
      detail: 'Gateway activo. La versión del CLI no pudo resolverse desde este proceso.',
    };
  }

  if (installed && version) {
    return {
      installed: true,
      version,
      gatewayActive: false,
      detail: `CLI ${version} detectado, pero el gateway no aparece activo`,
    };
  }

  if (installed) {
    return {
      installed: true,
      version,
      gatewayActive: false,
      detail: 'Se detectó instalación o servicio de OpenClaw, pero no está activo ahora mismo',
    };
  }

  return {
    installed: false,
    version: null,
    gatewayActive: null,
    detail: 'OpenClaw no se detectó desde este entorno',
  };
}

function computePosture(
  firewallActive: boolean | null,
  sshNetworkBound: boolean,
  listeningPorts: ListeningPort[],
): SecuritySnapshot['posture'] {
  const highRiskPortCount = listeningPorts.filter((item) => item.networkReachable && item.severity === 'high').length;
  const mediumRiskPortCount = listeningPorts.filter((item) => item.networkReachable && item.severity === 'medium').length;
  let score = 94;

  if (firewallActive === false) {
    score -= 18;
  } else if (firewallActive === null) {
    score -= 6;
  }

  if (sshNetworkBound) {
    score -= 12;
  }

  score -= Math.min(28, highRiskPortCount * 8);
  score -= Math.min(12, mediumRiskPortCount * 4);
  score = clamp(score, 18, 99);

  if (score >= 80) {
    return {
      score,
      level: 'healthy',
      label: 'Sólida',
      summary: 'La exposición aparente es baja o está razonablemente contenida.',
    };
  }

  if (score >= 55) {
    return {
      score,
      level: 'watch',
      label: 'Atención',
      summary: 'Hay señales que conviene revisar antes de dar por cerrado el endurecimiento.',
    };
  }

  return {
    score,
    level: 'hot',
    label: 'Expuesta',
    summary: 'La superficie visible desde el host merece revisión prioritaria.',
  };
}

async function collectHost(): Promise<HostSnapshot> {
  const [osInfo, cpu, netIfaces] = await Promise.all([si.osInfo(), si.cpu(), si.networkInterfaces()]);
  const primaryInterface = netIfaces.find((item) => !item.internal && item.ip4);

  return {
    hostname: os.hostname(),
    platform: osInfo.platform,
    distro: osInfo.distro,
    release: osInfo.release,
    kernel: osInfo.kernel,
    arch: os.arch(),
    cpuModel: `${cpu.manufacturer} ${cpu.brand}`.trim(),
    cpuCores: cpu.cores,
    uptimeSeconds: os.uptime(),
    primaryIp: primaryInterface?.ip4 ?? null,
    nodeVersion: process.version,
  };
}

async function collectLiveMetrics(): Promise<LiveMetrics> {
  const [currentLoad, mem, fsSize, networkStats, temp] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats(),
    si.cpuTemperature(),
  ]);

  const rootFs = fsSize.find((item) => item.mount === '/') ?? [...fsSize].sort((left, right) => right.size - left.size)[0];
  const rx = networkStats.reduce((sum, item) => sum + (item.rx_sec ?? 0), 0);
  const tx = networkStats.reduce((sum, item) => sum + (item.tx_sec ?? 0), 0);
  const [load1, load5, load15] = os.loadavg();

  return {
    timestamp: Date.now(),
    cpuUsage: round(currentLoad.currentLoad),
    cpuTempC: Number.isFinite(temp.main) ? round(temp.main) : null,
    load1: round(load1, 2),
    load5: round(load5, 2),
    load15: round(load15, 2),
    memoryUsedPercent: round((mem.active / mem.total) * 100),
    memoryUsedGb: bytesToGb(mem.active),
    memoryTotalGb: bytesToGb(mem.total),
    diskUsedPercent: rootFs ? round(rootFs.use) : 0,
    diskUsedGb: rootFs ? bytesToGb(rootFs.used) : 0,
    diskTotalGb: rootFs ? bytesToGb(rootFs.size) : 0,
    networkRxKBps: round(rx / 1024, 2),
    networkTxKBps: round(tx / 1024, 2),
  };
}

async function refreshLiveMetrics(): Promise<LiveMetrics> {
  if (sampleInFlight && latestLive) {
    return latestLive;
  }

  sampleInFlight = true;

  try {
    const sample = await collectLiveMetrics();
    latestLive = sample;
    pushHistory(sample);
    return sample;
  } finally {
    sampleInFlight = false;
  }
}

function normalizeProcessName(name: string, command?: string): string {
  const candidate = (name && name !== 'node' ? name : command ?? name ?? 'proceso').trim();
  const firstToken = candidate.split(/\s+/)[0] ?? candidate;
  return firstToken.includes('/') ? path.basename(firstToken) : firstToken || 'proceso';
}

async function collectProcesses(): Promise<ServiceSnapshot['topProcesses']> {
  const processData = await si.processes();

  return processData.list
    .slice()
    .sort((left, right) => {
      const cpuDelta = (right.cpu ?? 0) - (left.cpu ?? 0);
      if (cpuDelta !== 0) {
        return cpuDelta;
      }

      return (right.memRss ?? 0) - (left.memRss ?? 0);
    })
    .slice(0, 8)
    .map((item) => ({
      pid: item.pid,
      name: normalizeProcessName(item.name || item.command || 'proceso', item.command),
      cpu: round(item.cpu ?? 0),
      memoryMb: bytesToMb(normalizeProcessRss(item.memRss ?? 0)),
      memoryPercent: round(item.mem ?? 0),
    }));
}

async function collectStaticSnapshot(): Promise<Omit<DashboardPayload, 'generatedAt' | 'historyWindow' | 'live' | 'history'>> {
  const [hostSnapshot, firewall, listeningPorts, openclaw, topProcesses] = await Promise.all([
    collectHost(),
    detectFirewall(),
    collectListeningPorts(),
    detectOpenClaw(),
    collectProcesses(),
  ]);

  const sshPorts = listeningPorts.filter((item) => item.port === '22');
  const sshNetworkBound = sshPorts.some((item) => item.networkReachable);
  const networkPortCount = listeningPorts.filter((item) => item.networkReachable).length;
  const highRiskPortCount = listeningPorts.filter((item) => item.networkReachable && item.severity === 'high').length;
  const mediumRiskPortCount = listeningPorts.filter((item) => item.networkReachable && item.severity === 'medium').length;

  return {
    staticCollectedAt: new Date().toISOString(),
    host: hostSnapshot,
    security: {
      firewall,
      ssh: {
        active: sshPorts.length > 0,
        networkBound: sshNetworkBound,
        detail:
          sshPorts.length === 0
            ? 'No se detectó sshd escuchando en el puerto 22'
            : sshNetworkBound
              ? `SSH escucha fuera de loopback en ${sshPorts.map((item) => item.bindLabel).join(', ')}. Eso describe alcance local del bind, no prueba acceso público real; un firewall o NSG todavía puede restringirlo.`
              : `SSH permanece limitado a loopback en ${sshPorts.map((item) => item.bindLabel).join(', ')}`,
      },
      listeningPorts,
      networkPortCount,
      highRiskPortCount,
      mediumRiskPortCount,
      posture: computePosture(firewall.active, sshNetworkBound, listeningPorts),
    },
    services: {
      openclaw,
      topProcesses,
    },
  };
}

async function getStaticSnapshot(): Promise<Omit<DashboardPayload, 'generatedAt' | 'historyWindow' | 'live' | 'history'>> {
  if (staticCache && staticCache.expiresAt > Date.now()) {
    return staticCache.payload;
  }

  const payload = await collectStaticSnapshot();
  staticCache = {
    expiresAt: Date.now() + STATIC_CACHE_MS,
    payload,
  };
  return payload;
}

async function buildDashboardPayload(
  windowKey: HistoryWindowKey = DEFAULT_HISTORY_WINDOW,
  liveOverride?: LiveMetrics,
): Promise<DashboardPayload> {
  const live = liveOverride ?? latestLive ?? (await refreshLiveMetrics());
  const staticSnapshot = await getStaticSnapshot();

  return {
    generatedAt: new Date(live.timestamp).toISOString(),
    historyWindow: windowKey,
    ...staticSnapshot,
    live,
    history: selectHistory(windowKey),
  } satisfies DashboardPayload;
}

function writeStreamEvent(client: Response, payload: DashboardPayload): void {
  client.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function broadcastDashboard(liveOverride?: LiveMetrics): Promise<void> {
  if (streamClients.size === 0) {
    return;
  }

  const payloadByWindow = new Map<HistoryWindowKey, DashboardPayload>();

  for (const [client, windowKey] of [...streamClients.entries()]) {
    try {
      if (!payloadByWindow.has(windowKey)) {
        payloadByWindow.set(windowKey, await buildDashboardPayload(windowKey, liveOverride));
      }

      writeStreamEvent(client, payloadByWindow.get(windowKey)!);
    } catch {
      streamClients.delete(client);
      client.end();
    }
  }
}

async function refreshAndBroadcast(): Promise<void> {
  const sample = await refreshLiveMetrics();
  await broadcastDashboard(sample);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const windowKey = parseHistoryWindow(req.query.window);
    res.json(await buildDashboardPayload(windowKey));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    res.status(500).json({ error: message });
  }
});

app.get('/api/stream', async (req, res) => {
  const windowKey = parseHistoryWindow(req.query.window);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 2000\n\n');

  streamClients.set(res, windowKey);

  try {
    writeStreamEvent(res, await buildDashboardPayload(windowKey));
  } catch {
    res.write('event: error\ndata: {"error":"snapshot unavailable"}\n\n');
  }

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 15_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    streamClients.delete(res);
    res.end();
  });
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(clientDist));

  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

void refreshAndBroadcast();
setInterval(() => {
  void refreshAndBroadcast();
}, SAMPLE_INTERVAL_MS).unref();

app.listen(port, host, () => {
  console.log(`Monitoring Dashboard listening on http://${host}:${port}`);
});
