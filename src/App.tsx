import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownUp,
  Clock3,
  Cpu,
  Filter,
  Gauge,
  HardDrive,
  LayoutDashboard,
  Network,
  RefreshCcw,
  Server,
  Shield,
  Thermometer,
  Wifi,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type HistoryWindowKey = '5m' | '30m' | '1h';
type StreamState = 'connecting' | 'live' | 'reconnecting' | 'fallback' | 'offline';
type ListenerScope = 'loopback' | 'private' | 'all-interfaces' | 'public-ip' | 'unknown';
type ListenerExposure = 'loopback' | 'private-network' | 'wide-network' | 'public-hint' | 'unknown';
type ListenerSeverity = 'low' | 'medium' | 'high';

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

type DashboardPayload = {
  generatedAt: string;
  staticCollectedAt: string;
  historyWindow: HistoryWindowKey;
  host: {
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
  live: LiveMetrics;
  history: LiveMetrics[];
  security: {
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
  services: {
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
};

type HistoryPoint = {
  iso: string;
  time: string;
  cpu: number;
  memory: number;
  rx: number;
  tx: number;
};

type AlertItem = {
  id: string;
  title: string;
  description: string;
  tone: 'healthy' | 'watch' | 'hot';
  icon: ReactNode;
};

const HISTORY_WINDOW_OPTIONS: Array<{ key: HistoryWindowKey; label: string }> = [
  { key: '5m', label: '5 min' },
  { key: '30m', label: '30 min' },
  { key: '1h', label: '1 h' },
];

const streamTone = {
  connecting: 'tone-watch',
  live: 'tone-healthy',
  reconnecting: 'tone-watch',
  fallback: 'tone-watch',
  offline: 'tone-hot',
} as const;

const postureTone = {
  healthy: 'tone-healthy',
  watch: 'tone-watch',
  hot: 'tone-hot',
} as const;

const severityTone = {
  low: 'tone-healthy',
  medium: 'tone-watch',
  high: 'tone-hot',
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toneForPercent(value: number): 'healthy' | 'watch' | 'hot' {
  if (value >= 85) return 'hot';
  if (value >= 70) return 'watch';
  return 'healthy';
}

function fillTone(value: number): string {
  const tone = toneForPercent(value);
  return tone === 'healthy' ? 'fill-healthy' : tone === 'watch' ? 'fill-watch' : 'fill-hot';
}

function streamLabel(state: StreamState): string {
  switch (state) {
    case 'live':
      return 'Actualización en vivo';
    case 'connecting':
      return 'Conectando telemetría';
    case 'reconnecting':
      return 'Reconectando stream';
    case 'fallback':
      return 'Respaldo por sondeo';
    default:
      return 'Sin stream disponible';
  }
}

function formatAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `hace ${seconds}s`;
  if (seconds < 3600) return `hace ${Math.round(seconds / 60)}m`;
  return `hace ${Math.round(seconds / 3600)}h`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'UTC',
  });
}

function formatHistory(history: LiveMetrics[], historyWindow: HistoryWindowKey): HistoryPoint[] {
  const showSeconds = historyWindow === '5m';

  return history.map((sample) => ({
    iso: new Date(sample.timestamp).toISOString(),
    time: new Date(sample.timestamp).toLocaleTimeString('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
      second: showSeconds ? '2-digit' : undefined,
      hour12: false,
      timeZone: 'UTC',
    }),
    cpu: sample.cpuUsage,
    memory: sample.memoryUsedPercent,
    rx: sample.networkRxKBps,
    tx: sample.networkTxKBps,
  }));
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function formatRate(value: number): string {
  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)} MB/s`;
  }

  return `${value.toFixed(1)} KB/s`;
}

function describePortScope(scope: ListenerScope): string {
  switch (scope) {
    case 'loopback':
      return 'Solo host';
    case 'private':
      return 'Red privada';
    case 'all-interfaces':
      return 'Todas las interfaces';
    case 'public-ip':
      return 'IP pública';
    default:
      return 'No concluyente';
  }
}

function describeExposure(exposure: ListenerExposure): string {
  switch (exposure) {
    case 'loopback':
      return 'Local';
    case 'private-network':
      return 'Privada';
    case 'wide-network':
      return 'Amplia';
    case 'public-hint':
      return 'Pista pública';
    default:
      return 'Indefinida';
  }
}

function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ key: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="control-group">
      <span className="control-label">{label}</span>
      <div className="segmented-control" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            className={option.key === value ? 'active' : undefined}
            aria-pressed={option.key === value}
            onClick={() => onChange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MetricCard({
  title,
  value,
  subtitle,
  footnote,
  progress,
  tone,
  icon,
}: {
  title: string;
  value: string;
  subtitle: string;
  footnote: string;
  progress: number;
  tone: 'healthy' | 'watch' | 'hot';
  icon: ReactNode;
}) {
  return (
    <article className="metric-card panel">
      <div className="metric-head">
        <div className="metric-head-copy">
          <span className="metric-title">{title}</span>
          <span className={`mini-badge ${postureTone[tone]}`}>
            {tone === 'healthy' ? 'Estable' : tone === 'watch' ? 'Atención' : 'Alto'}
          </span>
        </div>
        <span className="metric-icon">{icon}</span>
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-subtitle">{subtitle}</div>
      <div className="progress-track" aria-hidden="true">
        <span className={`progress-fill ${fillTone(progress)}`} style={{ width: `${clamp(progress, 0, 100)}%` }} />
      </div>
      <div className="metric-footnote">{footnote}</div>
    </article>
  );
}

export default function App() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowKey, setWindowKey] = useState<HistoryWindowKey>('5m');
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [listenerFilter, setListenerFilter] = useState<'actionable' | 'network' | 'all'>('actionable');
  const [processSort, setProcessSort] = useState<'cpu' | 'memory'>('cpu');

  useEffect(() => {
    let cancelled = false;
    let stream: EventSource | null = null;
    let fallbackPoll: number | null = null;

    const stopFallback = () => {
      if (fallbackPoll !== null) {
        window.clearInterval(fallbackPoll);
        fallbackPoll = null;
      }
    };

    const loadSnapshot = async (options?: { initial?: boolean; viaFallback?: boolean }) => {
      try {
        const response = await fetch(`/api/dashboard?window=${windowKey}`);
        if (!response.ok) {
          throw new Error(`API respondió ${response.status}`);
        }

        const payload = (await response.json()) as DashboardPayload;
        if (cancelled) {
          return;
        }

        setData(payload);
        setError(null);
        setLastEventAt(payload.generatedAt);
        if (options?.initial) {
          setLoading(false);
        }
        if (options?.viaFallback) {
          setStreamState('fallback');
        }
      } catch (err) {
        if (cancelled) {
          return;
        }

        if (options?.initial) {
          setError(err instanceof Error ? err.message : 'Error desconocido');
          setLoading(false);
          setStreamState('offline');
        } else if (options?.viaFallback) {
          setStreamState('fallback');
        } else {
          setStreamState('reconnecting');
        }
      }
    };

    const startFallback = () => {
      if (fallbackPoll !== null) {
        return;
      }

      fallbackPoll = window.setInterval(() => {
        void loadSnapshot({ viaFallback: true });
      }, 5000);
    };

    setStreamState('connecting');
    void loadSnapshot({ initial: true });

    if (typeof EventSource === 'undefined') {
      setStreamState('fallback');
      startFallback();
      return () => {
        cancelled = true;
        stopFallback();
      };
    }

    stream = new EventSource(`/api/stream?window=${windowKey}`);
    stream.onopen = () => {
      if (!cancelled) {
        stopFallback();
        setStreamState('live');
      }
    };
    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as DashboardPayload;
        if (!cancelled) {
          setData(payload);
          setError(null);
          setLoading(false);
          setStreamState('live');
          setLastEventAt(payload.generatedAt);
          stopFallback();
        }
      } catch {
        if (!cancelled) {
          setStreamState('reconnecting');
          startFallback();
        }
      }
    };
    stream.onerror = () => {
      if (!cancelled) {
        setStreamState('reconnecting');
        startFallback();
      }
    };

    return () => {
      cancelled = true;
      stopFallback();
      stream?.close();
    };
  }, [windowKey]);

  const history = useMemo(
    () => formatHistory(data?.history ?? [], data?.historyWindow ?? windowKey),
    [data?.history, data?.historyWindow, windowKey],
  );

  const networkPeak = useMemo(() => {
    return history.reduce((peak, point) => Math.max(peak, point.rx, point.tx), 1);
  }, [history]);

  const sortedProcesses = useMemo(() => {
    const list = [...(data?.services.topProcesses ?? [])];
    return list.sort((left, right) => {
      if (processSort === 'cpu') {
        const cpuDelta = right.cpu - left.cpu;
        if (cpuDelta !== 0) return cpuDelta;
        return right.memoryMb - left.memoryMb;
      }

      const memoryDelta = right.memoryMb - left.memoryMb;
      if (memoryDelta !== 0) return memoryDelta;
      return right.cpu - left.cpu;
    });
  }, [data?.services.topProcesses, processSort]);

  const filteredListeners = useMemo(() => {
    const listeners = data?.security.listeningPorts ?? [];
    if (listenerFilter === 'all') {
      return listeners;
    }
    if (listenerFilter === 'network') {
      return listeners.filter((listener) => listener.networkReachable);
    }
    return listeners.filter(
      (listener) => listener.networkReachable || listener.severity !== 'low' || listener.sensitive,
    );
  }, [data?.security.listeningPorts, listenerFilter]);

  const alerts = useMemo<AlertItem[]>(() => {
    if (!data) {
      return [];
    }

    const items: AlertItem[] = [];
    const { live, security, services } = data;

    if (security.highRiskPortCount > 0) {
      items.push({
        id: 'listeners-high',
        title: `${security.highRiskPortCount} listeners de alta prioridad`,
        description: 'Hay servicios sensibles escuchando fuera de loopback. Conviene revisarlos primero.',
        tone: 'hot',
        icon: <AlertTriangle size={18} />,
      });
    } else if (security.posture.level !== 'healthy') {
      items.push({
        id: 'posture',
        title: `Postura ${security.posture.label.toLowerCase()}`,
        description: security.posture.summary,
        tone: security.posture.level,
        icon: <Shield size={18} />,
      });
    }

    if (live.cpuUsage >= 85 || live.memoryUsedPercent >= 85 || live.diskUsedPercent >= 85) {
      const resource = live.cpuUsage >= 85 ? 'CPU' : live.memoryUsedPercent >= 85 ? 'memoria' : 'disco';
      items.push({
        id: 'resource-pressure',
        title: `Presión alta sobre ${resource}`,
        description: 'La serie temporal ya muestra un valor en zona caliente. Merece observación inmediata.',
        tone: 'hot',
        icon: <Activity size={18} />,
      });
    }

    if (streamState !== 'live') {
      items.push({
        id: 'feed-state',
        title: 'Telemetría degradada',
        description: 'El dashboard sigue operando, pero la actualización en vivo no está en modo ideal.',
        tone: streamState === 'offline' ? 'hot' : 'watch',
        icon: <RefreshCcw size={18} />,
      });
    }

    if (services.openclaw.gatewayActive === false) {
      items.push({
        id: 'openclaw',
        title: 'Gateway de OpenClaw detenido',
        description: 'La CLI está detectada, pero el gateway no aparece activo en este momento.',
        tone: 'watch',
        icon: <Network size={18} />,
      });
    }

    if (items.length === 0) {
      items.push({
        id: 'all-good',
        title: 'Sin alertas operativas críticas',
        description: 'La ventana actual no muestra presión fuerte ni exposición especialmente preocupante.',
        tone: 'healthy',
        icon: <Shield size={18} />,
      });
    }

    return items.slice(0, 3);
  }, [data, streamState]);

  const highlightedListeners = useMemo(() => {
    return (data?.security.listeningPorts ?? []).filter((listener) => listener.severity !== 'low').slice(0, 3);
  }, [data?.security.listeningPorts]);

  if (loading) {
    return (
      <main className="app-shell" aria-busy="true">
        <section className="hero panel loading-panel">
          <div className="skeleton-line skeleton-line-short" />
          <div className="skeleton-line skeleton-line-long" />
          <div className="skeleton-line skeleton-line-medium" />
          <div className="loading-grid">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="skeleton-card" />
            ))}
          </div>
        </section>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="app-shell">
        <section className="hero panel state-panel state-panel-error">
          <p className="eyebrow">Monitoring Dashboard</p>
          <h1>No se pudo cargar el dashboard</h1>
          <p>{error ?? 'No hay datos disponibles.'}</p>
          <button type="button" className="action-button" onClick={() => window.location.reload()}>
            Reintentar
          </button>
        </section>
      </main>
    );
  }

  const { host, live, security, services } = data;
  const listenerFilterOptions = [
    { key: 'actionable', label: 'Accionables' },
    { key: 'network', label: 'No locales' },
    { key: 'all', label: 'Todos' },
  ] as const;
  const processSortOptions = [
    { key: 'cpu', label: 'CPU' },
    { key: 'memory', label: 'RAM' },
  ] as const;
  const diskFreeGb = Math.max(0, live.diskTotalGb - live.diskUsedGb);
  const networkActivity = Math.max(live.networkRxKBps, live.networkTxKBps);
  const topProcess = sortedProcesses[0];

  return (
    <main className="app-shell">
      <section className="hero panel">
        <div className="hero-main">
          <div className="hero-topline">
            <p className="eyebrow">Monitoring Dashboard</p>
            <span className="mini-badge neutral">
              <LayoutDashboard size={14} />
              Dashboard operativo
            </span>
          </div>
          <h1>Estado del host, con foco en salud, exposición y señales accionables</h1>
          <p className="hero-copy">
            Telemetría continua del sistema, inventario técnico depurado y contexto suficiente para decidir sin adivinar.
          </p>
          <div className="hero-controls">
            <SegmentedControl label="Ventana histórica" options={HISTORY_WINDOW_OPTIONS} value={windowKey} onChange={setWindowKey} />
          </div>
        </div>

        <div className="hero-aside">
          <div className={`status-badge status-badge-large ${postureTone[security.posture.level]}`}>
            <Shield size={18} />
            Postura {security.posture.score}/100 · {security.posture.label}
          </div>
          <div className={`status-badge ${streamTone[streamState]}`} aria-live="polite">
            <Activity size={16} />
            {streamLabel(streamState)}
          </div>
          <div className="hero-meta-card">
            <div className="hero-meta-row">
              <span>Host</span>
              <strong>{host.hostname}</strong>
            </div>
            <div className="hero-meta-row">
              <span>IP primaria</span>
              <strong>{host.primaryIp ?? 'sin IP detectada'}</strong>
            </div>
            <div className="hero-meta-row">
              <span>Última telemetría</span>
              <time dateTime={data.generatedAt}>{formatTimestamp(data.generatedAt)}</time>
            </div>
            <div className="hero-meta-row">
              <span>Inventario</span>
              <time dateTime={data.staticCollectedAt}>{formatAgo(data.staticCollectedAt)}</time>
            </div>
            <div className="hero-meta-row">
              <span>Último evento</span>
              <strong>{lastEventAt ? formatAgo(lastEventAt) : 'recién'}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="attention-grid">
        {alerts.map((alert) => (
          <article key={alert.id} className={`alert-card panel ${postureTone[alert.tone]}`}>
            <div className="alert-icon">{alert.icon}</div>
            <div className="alert-copy">
              <strong>{alert.title}</strong>
              <p>{alert.description}</p>
            </div>
          </article>
        ))}
      </section>

      <section className="metrics-grid">
        <MetricCard
          title="CPU"
          value={`${live.cpuUsage.toFixed(1)}%`}
          subtitle={`Load ${live.load1.toFixed(2)} · ${live.load5.toFixed(2)} · ${live.load15.toFixed(2)}`}
          footnote={live.cpuTempC !== null ? `Temperatura ${live.cpuTempC.toFixed(1)} °C` : 'Sin sensor térmico disponible'}
          progress={live.cpuUsage}
          tone={toneForPercent(live.cpuUsage)}
          icon={<Cpu size={18} />}
        />
        <MetricCard
          title="Memoria"
          value={`${live.memoryUsedPercent.toFixed(1)}%`}
          subtitle={`${live.memoryUsedGb.toFixed(2)} / ${live.memoryTotalGb.toFixed(2)} GB activas`}
          footnote={`Margen restante ${(live.memoryTotalGb - live.memoryUsedGb).toFixed(2)} GB`}
          progress={live.memoryUsedPercent}
          tone={toneForPercent(live.memoryUsedPercent)}
          icon={<Gauge size={18} />}
        />
        <MetricCard
          title="Disco"
          value={`${live.diskUsedPercent.toFixed(1)}%`}
          subtitle={`${live.diskUsedGb.toFixed(2)} / ${live.diskTotalGb.toFixed(2)} GB usados`}
          footnote={`${diskFreeGb.toFixed(2)} GB libres en el filesystem principal`}
          progress={live.diskUsedPercent}
          tone={toneForPercent(live.diskUsedPercent)}
          icon={<HardDrive size={18} />}
        />
        <MetricCard
          title="Red"
          value={`↓ ${formatRate(live.networkRxKBps)}`}
          subtitle={`↑ ${formatRate(live.networkTxKBps)}`}
          footnote={`Pico de la ventana ${formatRate(networkPeak)}`}
          progress={(networkActivity / Math.max(networkPeak, 1)) * 100}
          tone={toneForPercent((networkActivity / Math.max(networkPeak, 1)) * 100)}
          icon={<Wifi size={18} />}
        />
      </section>

      <section className="content-grid chart-grid">
        <article className="panel chart-panel">
          <div className="panel-head">
            <div className="panel-heading">
              <p className="section-label">Rendimiento</p>
              <h2>CPU y memoria</h2>
              <p className="panel-copy">
                Serie de los últimos {HISTORY_WINDOW_OPTIONS.find((option) => option.key === data.historyWindow)?.label.toLowerCase()} con umbrales operativos.
              </p>
            </div>
            <div className="panel-stamp">
              <Clock3 size={14} />
              {history.length} muestras
            </div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history}>
                <defs>
                  <linearGradient id="cpuGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="time" tickLine={false} axisLine={false} minTickGap={28} />
                <YAxis domain={[0, 100]} tickLine={false} axisLine={false} width={34} />
                <Tooltip
                  contentStyle={{ background: '#1f1613', border: '1px solid #4b362f', borderRadius: '14px' }}
                  labelStyle={{ color: '#fdecd2' }}
                  formatter={(value: number, name: string) => [`${value.toFixed(1)}%`, name === 'cpu' ? 'CPU' : 'Memoria']}
                />
                <Legend formatter={(value) => (value === 'cpu' ? 'CPU %' : 'Memoria %')} />
                <ReferenceLine y={70} stroke="rgba(245, 158, 11, 0.42)" strokeDasharray="4 4" />
                <ReferenceLine y={85} stroke="rgba(239, 68, 68, 0.48)" strokeDasharray="4 4" />
                <Area type="monotone" dataKey="cpu" stroke="#f59e0b" fill="url(#cpuGradient)" strokeWidth={2} />
                <Line type="monotone" dataKey="memory" stroke="#f5e6c8" dot={false} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-footer">
            <span className="chip">Umbral de observación: 70%</span>
            <span className="chip">Umbral caliente: 85%</span>
          </div>
        </article>

        <article className="panel chart-panel">
          <div className="panel-head">
            <div className="panel-heading">
              <p className="section-label">Tráfico</p>
              <h2>Entrada y salida de red</h2>
              <p className="panel-copy">
                Tráfico agregado de interfaces en la misma ventana histórica, pensado para detectar picos y caídas bruscas.
              </p>
            </div>
            <div className="panel-stamp">
              <RefreshCcw size={14} />
              {streamLabel(streamState)}
            </div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history}>
                <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                <XAxis dataKey="time" tickLine={false} axisLine={false} minTickGap={28} />
                <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={(value: number) => `${value.toFixed(0)}`} />
                <Tooltip
                  contentStyle={{ background: '#1f1613', border: '1px solid #4b362f', borderRadius: '14px' }}
                  labelStyle={{ color: '#fdecd2' }}
                  formatter={(value: number, name: string) => [formatRate(value), name === 'rx' ? 'Descarga' : 'Subida']}
                />
                <Legend formatter={(value) => (value === 'rx' ? 'Descarga' : 'Subida')} />
                <Line type="monotone" dataKey="rx" stroke="#7dd3fc" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="tx" stroke="#c084fc" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-footer">
            <span className="chip">Pico de descarga: {formatRate(history.reduce((peak, point) => Math.max(peak, point.rx), 0))}</span>
            <span className="chip">Pico de subida: {formatRate(history.reduce((peak, point) => Math.max(peak, point.tx), 0))}</span>
          </div>
        </article>
      </section>

      <section className="content-grid summary-grid">
        <article className="panel summary-panel">
          <div className="panel-head">
            <div className="panel-heading">
              <p className="section-label">Host</p>
              <h2>Contexto del sistema</h2>
            </div>
            <div className="panel-stamp">
              <Server size={14} />
              {formatAgo(data.staticCollectedAt)}
            </div>
          </div>
          <dl className="spec-list">
            <div>
              <dt>Sistema</dt>
              <dd>{host.distro} {host.release}</dd>
            </div>
            <div>
              <dt>Kernel</dt>
              <dd>{host.kernel}</dd>
            </div>
            <div>
              <dt>Arquitectura</dt>
              <dd>{host.arch}</dd>
            </div>
            <div>
              <dt>CPU</dt>
              <dd>{host.cpuModel} · {host.cpuCores} cores</dd>
            </div>
            <div>
              <dt>Uptime</dt>
              <dd>{formatUptime(host.uptimeSeconds)}</dd>
            </div>
            <div>
              <dt>Node.js</dt>
              <dd>{host.nodeVersion}</dd>
            </div>
            <div>
              <dt>Temperatura</dt>
              <dd>{live.cpuTempC !== null ? `${live.cpuTempC.toFixed(1)} °C` : 'Sin sensor'}</dd>
            </div>
          </dl>
        </article>

        <article className="panel summary-panel">
          <div className="panel-head">
            <div className="panel-heading">
              <p className="section-label">Seguridad</p>
              <h2>Postura y superficie expuesta</h2>
              <p className="panel-copy">
                Esta lectura clasifica alcance de escucha local. No sustituye reglas NSG, ACLs cloud ni firewalls perimetrales.
              </p>
            </div>
            <div className="panel-stamp">
              <Shield size={14} />
              {security.posture.label}
            </div>
          </div>

          <div className={`summary-box ${postureTone[security.posture.level]}`}>
            <span className="summary-score">{security.posture.score}</span>
            <div>
              <strong>{security.posture.summary}</strong>
              <p>{security.firewall.detail} · {security.ssh.detail}</p>
            </div>
          </div>

          <div className="chips">
            <span className="chip">Firewall: {security.firewall.active === null ? 'sin señal' : security.firewall.active ? 'activo' : 'inactivo'}</span>
            <span className="chip">SSH: {security.ssh.active ? security.ssh.networkBound ? 'fuera de loopback' : 'solo local' : 'no detectado'}</span>
            <span className="chip">Listeners no locales: {security.networkPortCount}</span>
            <span className="chip">Alta prioridad: {security.highRiskPortCount}</span>
          </div>

          <ul className="signal-list">
            {highlightedListeners.length > 0 ? (
              highlightedListeners.map((listener) => (
                <li key={listener.id}>
                  <div className="signal-main">
                    <span className={`table-badge ${severityTone[listener.severity]}`}>
                      {listener.severity === 'high' ? 'Alta' : listener.severity === 'medium' ? 'Media' : 'Baja'}
                    </span>
                    <div className="signal-title">
                      <strong>{listener.process || 'Proceso sin identificar'} · {listener.protocol.toUpperCase()} {listener.port}</strong>
                      <span>{describeExposure(listener.exposure)} · {describePortScope(listener.scope)}</span>
                    </div>
                  </div>
                  <p className="signal-note">{listener.notes}</p>
                </li>
              ))
            ) : (
              <li>
                <div className="signal-title">
                  <strong>Sin listeners destacados</strong>
                  <span>La tabla inferior queda disponible por si quieres revisar el inventario completo.</span>
                </div>
              </li>
            )}
          </ul>
        </article>

        <article className="panel summary-panel">
          <div className="panel-head">
            <div className="panel-heading">
              <p className="section-label">Servicios</p>
              <h2>OpenClaw y proceso dominante</h2>
            </div>
            <div className="panel-stamp">
              <Network size={14} />
              {formatAgo(data.staticCollectedAt)}
            </div>
          </div>

          <div className="op-status">
            <div className={`status-dot ${services.openclaw.gatewayActive ? 'online' : services.openclaw.gatewayActive === false ? 'idle' : 'unknown'}`} />
            <div>
              <strong>
                {services.openclaw.gatewayActive === true
                  ? 'Gateway activo'
                  : services.openclaw.gatewayActive === false
                    ? 'Gateway detenido'
                    : 'Estado no concluyente'}
              </strong>
              <p>{services.openclaw.detail}</p>
            </div>
          </div>

          <div className="chips">
            <span className="chip">Instalado: {services.openclaw.installed ? 'sí' : 'no'}</span>
            <span className="chip">Versión: {services.openclaw.version ?? 'sin resolver'}</span>
          </div>

          <div className="dominant-process">
            <div className="dominant-process-head">
              <Thermometer size={16} />
              <strong>Proceso dominante</strong>
            </div>
            {topProcess ? (
              <div className="dominant-process-body">
                <span>{topProcess.name} · PID {topProcess.pid}</span>
                <span>CPU {topProcess.cpu.toFixed(1)}% · RAM {topProcess.memoryMb.toFixed(1)} MB</span>
              </div>
            ) : (
              <div className="dominant-process-body">
                <span>Sin procesos destacados en esta muestra</span>
              </div>
            )}
          </div>
        </article>
      </section>

      <section className="content-grid table-grid">
        <article className="panel table-panel">
          <div className="panel-head">
            <div className="panel-heading">
              <p className="section-label">Procesos</p>
              <h2>Consumo principal</h2>
              <p className="panel-copy">Ordenable por CPU o memoria, con RAM ya normalizada correctamente.</p>
            </div>
            <div className="panel-stamp">
              <ArrowDownUp size={14} />
              {processSort === 'cpu' ? 'Orden por CPU' : 'Orden por RAM'}
            </div>
          </div>

          <div className="table-controls">
            <SegmentedControl label="Ordenar" options={processSortOptions} value={processSort} onChange={setProcessSort} />
          </div>

          <div className="table-wrap">
            <table>
              <caption>Procesos con mayor consumo visible en la instantánea actual.</caption>
              <thead>
                <tr>
                  <th scope="col">PID</th>
                  <th scope="col">Proceso</th>
                  <th scope="col">CPU</th>
                  <th scope="col">RAM</th>
                  <th scope="col">% RAM</th>
                </tr>
              </thead>
              <tbody>
                {sortedProcesses.map((process) => (
                  <tr key={process.pid}>
                    <td data-label="PID">{process.pid}</td>
                    <td data-label="Proceso">
                      <div className="cell-stack">
                        <strong className="process-name">{process.name}</strong>
                      </div>
                    </td>
                    <td data-label="CPU">{process.cpu.toFixed(1)}%</td>
                    <td data-label="RAM">{process.memoryMb.toFixed(1)} MB</td>
                    <td data-label="% RAM">{process.memoryPercent.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>

        <article className="panel table-panel">
          <div className="panel-head">
            <div className="panel-heading">
              <p className="section-label">Listeners</p>
              <h2>Inventario depurado de puertos</h2>
              <p className="panel-copy">
                Duplicados IPv4/IPv6 consolidados por proceso, con severidad y explicación breve para priorizar revisión.
              </p>
            </div>
            <div className="panel-stamp">
              <Filter size={14} />
              {filteredListeners.length} visibles
            </div>
          </div>

          <div className="table-controls">
            <SegmentedControl label="Mostrar" options={listenerFilterOptions} value={listenerFilter} onChange={setListenerFilter} />
          </div>

          {filteredListeners.length > 0 ? (
            <div className="table-wrap">
              <table>
                <caption>Listeners detectados por el host, filtrados según su relevancia operativa.</caption>
                <thead>
                  <tr>
                    <th scope="col">Sev</th>
                    <th scope="col">Proceso</th>
                    <th scope="col">Puerto</th>
                    <th scope="col">Alcance</th>
                    <th scope="col">Bind</th>
                    <th scope="col">Notas</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredListeners.map((listener) => (
                    <tr key={listener.id}>
                      <td data-label="Sev">
                        <span className={`table-badge ${severityTone[listener.severity]}`}>
                          {listener.severity === 'high' ? 'Alta' : listener.severity === 'medium' ? 'Media' : 'Baja'}
                        </span>
                      </td>
                      <td data-label="Proceso">
                        <div className="cell-stack">
                          <strong className="process-name">{listener.process || 'sin detalles'}</strong>
                          <span className="cell-muted">{listener.protocol.toUpperCase()} · {describeExposure(listener.exposure)}</span>
                        </div>
                      </td>
                      <td data-label="Puerto">{listener.port}</td>
                      <td data-label="Alcance">{describePortScope(listener.scope)}</td>
                      <td data-label="Bind">
                        <div className="cell-stack">
                          <span>{listener.bindLabel}</span>
                          {listener.binds.length > 1 ? <span className="cell-muted">{listener.binds.length} binds consolidados</span> : null}
                        </div>
                      </td>
                      <td data-label="Notas">
                        <div className="cell-stack">
                          <span>{listener.notes}</span>
                          <span className="cell-muted">{listener.networkReachable ? 'Fuera de loopback' : 'Solo local'}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">No hay listeners para este filtro. Bastante civilizado, por una vez.</div>
          )}
        </article>
      </section>
    </main>
  );
}
