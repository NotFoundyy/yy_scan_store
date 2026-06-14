import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserQRCodeReader } from '@zxing/browser';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Boxes,
  Camera,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Download,
  Edit3,
  FileDown,
  Home,
  LockKeyhole,
  PackagePlus,
  Plus,
  QrCode,
  ScanLine,
  Search,
  Settings,
  Trash2,
  Upload,
  UserRound,
} from 'lucide-react';
import type { AuthSession } from './lib/auth';
import type { BackupFile, Box, Item, SharedBox, StockMovement } from './types/domain';
import { formatDate, formatDateOnly, fromDatetimeLocal, toDatetimeLocal } from './lib/dates';
import { fileToImageDataUrl } from './lib/images';
import { parseBoxesExcel } from './lib/importBoxesExcel';
import { createQrDataUrl, createQrLabelDataUrl } from './lib/qr';
import { defaultExportFileName, defaultMovementExportFileName, exportExcel, exportMovementsExcel } from './lib/exportExcel';
import { exportBackup, parseBackupFile, restoreBackup } from './lib/backup';
import { dataUrlToBase64, isNativeApp, saveDataUrlPhotoToGallery, shareBase64File } from './lib/nativeFiles';
import { displayBoxCode } from './lib/ids';
import { archiveBox, createBox, deleteBox, getBoxByCode, listBoxes, updateBox } from './repositories/boxes';
import { importBoxesWithItems } from './repositories/importBoxes';
import { changeStock, createItem, deleteItem, listAllItems, listItemsByBox, updateItem } from './repositories/items';
import { excludeOutboundMovementsFromExcelByTeams, listAllMovements, updateStockMovement } from './repositories/movements';
import { api, hasApiConfiguration } from './lib/api';
import { getLocalDataOwner, getSession, onSessionChange, setSession } from './lib/auth';
import { clearLocalAccountData, createShareQrValue, getSharedBox, getSyncStatus, invalidateCloudData, parseShareQrValue } from './lib/cloud';
import { getDatabaseSnapshot } from './lib/db';

type Route =
  | { name: 'home' }
  | { name: 'boxes' }
  | { name: 'scan' }
  | { name: 'tools' }
  | { name: 'box'; id: string }
  | { name: 'qr'; id: string }
  | { name: 'shared'; id: string; token: string };

type Toast = { type: 'success' | 'error'; message: string } | undefined;

const parseRoute = (): Route => {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'box' && parts[1] && parts[2] === 'qr') return { name: 'qr', id: parts[1] };
  if (parts[0] === 'box' && parts[1]) return { name: 'box', id: parts[1] };
  if (parts[0] === 'shared' && parts[1] && parts[2]) return { name: 'shared', id: parts[1], token: parts[2] };
  if (parts[0] === 'boxes') return { name: 'boxes' };
  if (parts[0] === 'scan') return { name: 'scan' };
  if (parts[0] === 'tools' || parts[0] === 'export' || parts[0] === 'backup' || parts[0] === 'settings') return { name: 'tools' };
  return { name: 'home' };
};

const routeToHash = (route: Route) => {
  if (route.name === 'home') return '#/';
  if (route.name === 'boxes') return '#/boxes';
  if (route.name === 'box') return `#/box/${route.id}`;
  if (route.name === 'qr') return `#/box/${route.id}/qr`;
  if (route.name === 'shared') return `#/shared/${route.id}/${route.token}`;
  return `#/${route.name}`;
};

const navItems: Array<{ route: Route; label: string; icon: typeof Boxes }> = [
  { route: { name: 'home' }, label: '首页', icon: Home },
  { route: { name: 'scan' }, label: '扫码', icon: ScanLine },
  { route: { name: 'boxes' }, label: '箱子', icon: Boxes },
  { route: { name: 'tools' }, label: '工具', icon: Settings },
];

const quantityText = (item: Item) => `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`;
const itemTitle = (item?: Item) => item?.name ?? '已删除物品';
const DEFAULT_LOW_STOCK_THRESHOLD = 2;
const COMMON_UNITS = ['个', '套', '米', '箱', '瓶', '件', '片', '根', '把', '只', '盒', '付'];
const naturalNameCompare = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare;
const isLowStock = (item: Item, fallbackThreshold: number) => item.quantity <= (item.lowStockThreshold ?? fallbackThreshold);
const todayKey = () => new Date().toLocaleDateString('sv-SE');
const movementTypeText = (type: StockMovement['type']) => (type === 'out' ? '出库' : type === 'in' ? '入库' : '调整');

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<Toast>();
  const toastTimerRef = useRef<number | undefined>(undefined);
  const [session, setAuthSession] = useState<AuthSession | undefined>(getSession);
  const [syncStatus, setSyncStatus] = useState({ queued: 0, conflicts: 0 });
  const [online, setOnline] = useState(navigator.onLine);
  const lowStockThreshold = DEFAULT_LOW_STOCK_THRESHOLD;

  const showToast = (next: Toast) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(next);
    toastTimerRef.current = window.setTimeout(() => setToast(undefined), 1800);
  };

  const loadAll = async () => {
    setLoading(true);
    const [boxRows, itemRows, movementRows] = await Promise.all([
      listBoxes(),
      listAllItems(),
      listAllMovements(),
    ]);
    setBoxes(boxRows);
    setItems(itemRows);
    setMovements(movementRows);
    setSyncStatus(await getSyncStatus());
    setLoading(false);
  };

  const navigate = (next: Route) => {
    window.location.hash = routeToHash(next);
  };

  useEffect(() => {
    const handleHash = () => setRoute(parseRoute());
    window.addEventListener('hashchange', handleHash);
    loadAll().catch((error) => showToast({ type: 'error', message: error.message }));
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);

  useEffect(() => onSessionChange(() => {
    const nextSession = getSession();
    setAuthSession(nextSession);
    invalidateCloudData();
    const prepare = nextSession ? Promise.resolve() : clearLocalAccountData();
    prepare.then(loadAll).catch((error) => showToast({ type: 'error', message: error.message }));
  }), []);

  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine && getSession()) loadAll().catch(() => undefined);
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const currentBox = route.name === 'box' || route.name === 'qr' ? boxes.find((box) => box.id === route.id) : undefined;

  if (!session && route.name !== 'scan' && route.name !== 'shared') {
    return <AuthPage navigate={navigate} showToast={showToast} />;
  }

  return (
    <div className="app-shell">
      {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
      <main className="app-main">
        {loading && <div className="state-block">正在读取本地数据...</div>}
        {!loading && route.name === 'home' && (
          <HomePage
            boxes={boxes}
            items={items}
            movements={movements}
            navigate={navigate}
            refresh={loadAll}
            showToast={showToast}
            lowStockThreshold={lowStockThreshold}
            online={online}
          />
        )}
        {!loading && route.name === 'boxes' && (
          <BoxListPage
            boxes={boxes}
            items={items}
            navigate={navigate}
            refresh={loadAll}
            showToast={showToast}
            lowStockThreshold={lowStockThreshold}
          />
        )}
        {!loading && route.name === 'box' && (
          <BoxDetailPage
            box={currentBox}
            movements={movements}
            navigate={navigate}
            refresh={loadAll}
            showToast={showToast}
            lowStockThreshold={lowStockThreshold}
          />
        )}
        {!loading && route.name === 'qr' && (
          <QrPage box={currentBox} navigate={navigate} showToast={showToast} refresh={loadAll} online={online} />
        )}
        {!loading && route.name === 'scan' && <ScanPage navigate={navigate} showToast={showToast} />}
        {!loading && route.name === 'shared' && <SharedBoxPage id={route.id} token={route.token} navigate={navigate} showToast={showToast} />}
        {!loading && route.name === 'tools' && (
          <ToolsPage
            boxes={boxes}
            items={items}
            movements={movements}
            showToast={showToast}
            refresh={loadAll}
            session={session!}
            online={online}
            syncStatus={syncStatus}
          />
        )}
      </main>
      {session && <BottomNav route={route} navigate={navigate} />}
    </div>
  );
}

function AuthPage({ navigate, showToast }: { navigate: (route: Route) => void; showToast: (toast: Toast) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const validUsername = /^[A-Za-z0-9_]{2,32}$/.test(username);
  const validPassword = password.length >= 6 && password.length <= 128;

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand"><Boxes size={38} /></div>
        <div className="auth-heading">
          <h1>老于智慧仓管</h1>
          <p>登录后，多台设备共享同一份箱子数据</p>
        </div>
        <div className="auth-tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>登录</button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); }}>注册</button>
        </div>
        {!hasApiConfiguration() && <p className="danger-text">尚未配置 VITE_API_BASE_URL，暂时无法登录。</p>}
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setError('');
            if (!validUsername) {
              setError('账号需要 2-32 位，只能使用字母、数字或下划线');
              return;
            }
            if (!validPassword) {
              setError('密码需要 6-128 位');
              return;
            }
            setSaving(true);
            try {
              const snapshot = await getDatabaseSnapshot();
              const localOwner = getLocalDataOwner();
              const legacyData = !localOwner && snapshot.boxes.length > 0;
              const nextSession = await api.post<AuthSession>(`/auth/${mode}`, { username, password });
              setSession(nextSession, false);
              if (localOwner && localOwner !== nextSession.user.id) {
                await clearLocalAccountData();
              } else if (legacyData) {
                if (confirm(`检测到本机有 ${snapshot.boxes.length} 个旧版箱子，是否上传到当前账号？`)) {
                  await api.post('/import', snapshot);
                  invalidateCloudData();
                } else {
                  await clearLocalAccountData();
                }
              }
              setSession(nextSession);
              showToast({ type: 'success', message: mode === 'login' ? '登录成功' : '注册成功' });
            } catch (error) {
              setSession(undefined, false);
              const message = error instanceof Error ? error.message : '登录失败';
              setError(message);
              showToast({ type: 'error', message });
            } finally {
              setSaving(false);
            }
          }}
        >
          <label className="auth-field">
            <UserRound size={20} />
            <input autoCapitalize="none" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value.trim())} placeholder="账号（字母、数字或下划线）" />
          </label>
          <label className="auth-field">
            <LockKeyhole size={20} />
            <input autoComplete={mode === 'login' ? 'current-password' : 'new-password'} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码（至少 6 位）" />
          </label>
          {error && <p className="auth-error">{error}</p>}
          <button className="primary full" disabled={saving || !hasApiConfiguration()}>
            {saving ? '请稍候...' : mode === 'login' ? '登录' : '创建账号'}
          </button>
        </form>
        <div className="auth-divider"><span>只查看别人分享的箱子</span></div>
        <button className="ghost full auth-scan" onClick={() => navigate({ name: 'scan' })}><ScanLine size={19} />不登录，直接扫码查看</button>
      </section>
    </main>
  );
}

function SharedBoxPage({
  id,
  token,
  navigate,
  showToast,
}: {
  id: string;
  token: string;
  navigate: (route: Route) => void;
  showToast: (toast: Toast) => void;
}) {
  const [data, setData] = useState<SharedBox>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getSharedBox(id, token)
      .then(setData)
      .catch((error) => showToast({ type: 'error', message: error instanceof Error ? error.message : '二维码无效' }))
      .finally(() => setLoading(false));
  }, [id, token]);

  if (loading) return <section><PageHeader title="正在读取箱子" /><div className="state-block">正在从服务器获取最新内容...</div></section>;
  if (!data) return <section><PageHeader title="无法查看箱子" back={() => navigate({ name: 'scan' })} /><EmptyState title="二维码无效" text="箱子可能已删除，或服务器暂时不可用。" /></section>;

  return (
    <section className="detail-page">
      <PageHeader title={data.box.name} subtitle={`${displayBoxCode(data.box.code)} · 只读查看`} back={() => navigate({ name: 'scan' })} />
      <div className="readonly-banner">二维码只读查看，库存数据来自服务器。</div>
      {data.items.length === 0 ? <EmptyState title="没有物品" text="这个箱子目前没有物品。" /> : (
        <div className="card-list">
          {data.items.map((item) => (
            <article className="item-card" key={item.id}>
              <div className="item-main">
                <CardPhoto imageDataUrl={item.imageDataUrl} alt={`${item.name} 图片`} className="item-photo" fallback={<PackagePlus size={24} />} />
                <div><strong>{item.name}</strong><span>{item.specModel || '未填规格'}</span></div>
                <b>{quantityText(item as Item)}</b>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function BottomNav({ route, navigate }: { route: Route; navigate: (route: Route) => void }) {
  const activeName = route.name === 'box' || route.name === 'qr' ? 'boxes' : route.name;

  return (
    <nav className="bottom-nav">
      {navItems.map((item) => {
        const Icon = item.icon;
        const active = activeName === item.route.name;
        return (
          <button key={item.label} className={active ? 'active' : ''} onClick={() => navigate(item.route)}>
            <Icon size={20} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function PageHeader({
  title,
  subtitle,
  back,
  action,
}: {
  title: string;
  subtitle?: string;
  back?: () => void;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="header-row">
        {back && (
          <button className="icon-btn" onClick={back} aria-label="返回">
            <ChevronLeft size={22} />
          </button>
        )}
        <div>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
      </div>
      {action}
    </header>
  );
}

function HomePage({
  boxes,
  items,
  movements,
  navigate,
  refresh,
  showToast,
  lowStockThreshold,
  online,
}: {
  boxes: Box[];
  items: Item[];
  movements: StockMovement[];
  navigate: (route: Route) => void;
  refresh: () => Promise<void>;
  showToast: (toast: Toast) => void;
  lowStockThreshold: number;
  online: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const lowStockCount = items.filter((item) => isLowStock(item, lowStockThreshold)).length;
  const todayMovements = movements.filter((movement) => movement.createdAt.slice(0, 10) === todayKey()).length;
  const todayIn = movements.filter((movement) => movement.createdAt.slice(0, 10) === todayKey() && movement.type === 'in').length;
  const todayOut = movements.filter((movement) => movement.createdAt.slice(0, 10) === todayKey() && movement.type === 'out').length;
  const visibleBoxes = useMemo(() => boxes.slice(0, 3), [boxes]);

  const handleCreate = async (input: { name: string; note?: string; imageDataUrl?: string }) => {
    const box = await createBox(input);
    await refresh();
    setCreating(false);
    showToast({ type: 'success', message: `已创建 ${box.name}` });
    navigate({ name: 'box', id: box.id });
  };

  return (
    <section className="home-page">
      <header className="home-header">
        <div>
          <h1>老于智慧仓管</h1>
          <p className={`home-sync ${online ? 'online' : 'offline'}`}>
            <span />
            {formatDateOnly(new Date().toISOString())} · {online ? '云端数据已同步' : '离线使用，联网后自动同步'}
          </p>
        </div>
      </header>

      <div className="overview-strip">
        <StatPill icon={<Boxes size={28} />} label="箱子" value={boxes.length} />
        <StatPill icon={<PackagePlus size={27} />} label="物品" value={items.length} />
        <StatPill icon={<Archive size={27} />} label="低库存" value={lowStockCount} tone={lowStockCount ? 'warning' : undefined} />
        <StatPill icon={<FileDown size={27} />} label={`今日 +${todayIn}/-${todayOut}`} value={todayMovements} />
      </div>

      <div className="home-actions">
        <button className="scan-hero" onClick={() => navigate({ name: 'scan' })}>
          <span>
            <Camera size={29} />
          </span>
          <div>
            <strong>扫码查箱</strong>
          </div>
          <ChevronRight size={25} />
        </button>
        <button className="add-box-tile" onClick={() => setCreating(true)}>
          <span>
            <Plus size={31} />
          </span>
          <div>
            <strong>新增箱子</strong>
          </div>
          <ChevronRight size={24} />
        </button>
      </div>

      <section className="home-section">
        <div className="section-heading">
          <h2>常用箱子</h2>
          <button onClick={() => navigate({ name: 'boxes' })}>
            查看全部 {boxes.length}
            <ChevronRight size={18} />
          </button>
        </div>
        {visibleBoxes.length === 0 ? (
          <EmptyState title="还没有箱子" text="先新增箱子，再录入物品和二维码。" />
        ) : (
          <div className="home-box-list">
            {visibleBoxes.map((box) => {
              const boxItems = items.filter((item) => item.boxId === box.id);
              const hasLowStock = boxItems.some((item) => isLowStock(item, lowStockThreshold));
              return (
                <div
                  className="home-box-row"
                  key={box.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate({ name: 'box', id: box.id })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') navigate({ name: 'box', id: box.id });
                  }}
                >
                  <CardPhoto imageDataUrl={box.imageDataUrl} alt={`${box.name} 图片`} className="box-icon" fallback={<Boxes size={25} />} />
                  <div>
                    <strong>{box.name}</strong>
                    <small>{displayBoxCode(box.code)}</small>
                  </div>
                  <div className="row-meta">
                    <span>物品 {boxItems.length}</span>
                    <small>{formatDate(box.updatedAt)}</small>
                  </div>
                  <span className={`status-chip ${hasLowStock ? 'warning' : ''}`}>{hasLowStock ? '低库存' : '正常'}</span>
                  <ChevronRight size={22} />
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="home-section">
        <div className="section-heading">
          <h2>最近流水</h2>
          <button onClick={() => navigate({ name: 'tools' })}>
            查看全部 {movements.length}
            <ChevronRight size={18} />
          </button>
        </div>
        {movements.length === 0 ? (
          <p className="muted-line">暂无出入库记录。</p>
        ) : (
          <div className="movement-list">
            {movements.slice(0, 2).map((movement) => {
              const box = boxes.find((entry) => entry.id === movement.boxId);
              const isOut = movement.type === 'out';
              return (
                <div className="home-movement-row" key={movement.id}>
                  <span className={isOut ? 'move-icon out' : 'move-icon in'}>
                    {isOut ? <ArrowUp size={25} /> : <ArrowDown size={25} />}
                  </span>
                  <div>
                    <strong>
                      {movementTypeText(movement.type)} <span>{box?.name ?? '未知箱子'}</span>
                    </strong>
                    <small>{movement.teamName ? `操作：${movement.teamName}` : formatDateOnly(movement.createdAt)}</small>
                  </div>
                  <b className={isOut ? 'out' : 'in'}>
                    {isOut ? '-' : '+'}
                    {movement.quantity}
                  </b>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {creating && <BoxFormDialog title="新增箱子" onCancel={() => setCreating(false)} onSubmit={handleCreate} />}
    </section>
  );
}

function StatPill({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone?: 'warning';
}) {
  return (
    <div className={`stat-pill ${tone ?? ''}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function BoxListPage({
  boxes,
  items,
  navigate,
  refresh,
  showToast,
  lowStockThreshold,
}: {
  boxes: Box[];
  items: Item[];
  navigate: (route: Route) => void;
  refresh: () => Promise<void>;
  showToast: (toast: Toast) => void;
  lowStockThreshold: number;
}) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'low' | 'normal'>('all');
  const itemsByBox = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const item of items) {
      const list = map.get(item.boxId);
      if (list) list.push(item);
      else map.set(item.boxId, [item]);
    }
    return map;
  }, [items]);

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    const rows = boxes.filter((box) => {
      const boxItems = itemsByBox.get(box.id) ?? [];
      const low = boxItems.some((item) => isLowStock(item, lowStockThreshold));
      const textMatched = !text || `${box.name} ${box.code} ${box.note ?? ''}`.toLowerCase().includes(text);
      const statusMatched = statusFilter === 'all' || (statusFilter === 'low' ? low : !low);
      return textMatched && statusMatched;
    });
    return rows.sort((a, b) => naturalNameCompare(a.name, b.name));
  }, [boxes, itemsByBox, lowStockThreshold, query, statusFilter]);

  const handleCreate = async (input: { name: string; note?: string; imageDataUrl?: string }) => {
    const box = await createBox(input);
    await refresh();
    setCreating(false);
    showToast({ type: 'success', message: `已创建 ${box.name}` });
    navigate({ name: 'box', id: box.id });
  };

  return (
    <section>
      <PageHeader
        title="箱子"
        subtitle={`${boxes.length} 个箱子，${items.length} 个物品`}
        action={
          <div className="header-actions">
            <button className="ghost icon-only" onClick={() => navigate({ name: 'scan' })} aria-label="扫码查箱">
              <ScanLine size={19} />
            </button>
            <button className="primary small" onClick={() => setCreating(true)}>
              <Plus size={18} />
              新建
            </button>
          </div>
        }
      />
      <div className="tool-row">
        <label className="search-box">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索箱子" />
        </label>
      </div>
      <div className="list-controls">
        <div className="filter-tabs">
          <button className={statusFilter === 'all' ? 'active' : ''} onClick={() => setStatusFilter('all')}>全部</button>
          <button className={statusFilter === 'low' ? 'active' : ''} onClick={() => setStatusFilter('low')}>低库存</button>
          <button className={statusFilter === 'normal' ? 'active' : ''} onClick={() => setStatusFilter('normal')}>正常</button>
        </div>
      </div>
      {filtered.length === 0 ? (
        <EmptyState title="还没有箱子" text="先创建一个箱子，再添加物品和生成二维码。" />
      ) : (
        <div className="card-list">
          {filtered.map((box) => {
            const boxItems = itemsByBox.get(box.id) ?? [];
            const hasLowStock = boxItems.some((item) => isLowStock(item, lowStockThreshold));
            return (
              <div
                key={box.id}
                className="box-card"
                role="button"
                tabIndex={0}
                onClick={() => navigate({ name: 'box', id: box.id })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') navigate({ name: 'box', id: box.id });
                }}
              >
                <CardPhoto imageDataUrl={box.imageDataUrl} alt={`${box.name} 图片`} className="box-icon" fallback={<Boxes size={22} />} />
                <div>
                  <strong>{box.name}</strong>
                  <span>{displayBoxCode(box.code)}</span>
                </div>
                <div className="card-meta">
                  <span>{boxItems.length} 种物品</span>
                  <span className={`status-chip mini ${hasLowStock ? 'warning' : ''}`}>{hasLowStock ? '低库存' : '正常'}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <button className="fab" onClick={() => setCreating(true)} aria-label="新建箱子">
        <Plus />
      </button>
      {creating && (
        <BoxFormDialog title="新建箱子" onCancel={() => setCreating(false)} onSubmit={handleCreate} />
      )}
    </section>
  );
}

function BoxDetailPage({
  box,
  movements,
  navigate,
  refresh,
  showToast,
  lowStockThreshold,
}: {
  box?: Box;
  movements: StockMovement[];
  navigate: (route: Route) => void;
  refresh: () => Promise<void>;
  showToast: (toast: Toast) => void;
  lowStockThreshold: number;
}) {
  const [boxItems, setBoxItems] = useState<Item[]>([]);
  const [editingBox, setEditingBox] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | 'new'>();
  const [stockAction, setStockAction] = useState<{ item: Item; type: 'in' | 'out' }>();
  const [showBoxTools, setShowBoxTools] = useState(false);
  const [claimRecordsOpen, setClaimRecordsOpen] = useState(false);

  const loadBoxData = async () => {
    if (!box) return;
    const itemRows = await listItemsByBox(box.id);
    setBoxItems(itemRows);
  };

  useEffect(() => {
    loadBoxData().catch((error) => showToast({ type: 'error', message: error.message }));
  }, [box?.id]);

  if (!box) {
    return (
      <section>
        <PageHeader title="未找到箱子" back={() => navigate({ name: 'boxes' })} />
        <EmptyState title="箱子不存在" text="可能已删除，或当前浏览器没有这份数据。" />
      </section>
    );
  }

  const reload = async () => {
    await Promise.all([refresh(), loadBoxData()]);
  };

  const handleArchive = async () => {
    if (!confirm(`确认归档“${box.name}”？归档后列表中不会显示。`)) return;
    await archiveBox(box);
    await refresh();
    showToast({ type: 'success', message: '箱子已归档' });
    navigate({ name: 'boxes' });
  };

  const handleDeleteBox = async () => {
    if (!confirm(`确认删除“${box.name}”？箱内物品和相关流水都会一起删除，删除后不能恢复。`)) return;
    await deleteBox(box);
    await refresh();
    showToast({ type: 'success', message: '箱子已删除' });
    navigate({ name: 'boxes' });
  };

  return (
    <section className="detail-page">
      <PageHeader
        title={box.name}
        subtitle={`${displayBoxCode(box.code)} · ${boxItems.length} 种物品`}
        back={() => navigate({ name: 'boxes' })}
        action={
          <div className="header-actions">
            <button className="plus-menu-btn" onClick={() => setShowBoxTools((value) => !value)} aria-label="更多操作">
              <Plus size={22} />
            </button>
          </div>
        }
      />

      {showBoxTools && (
        <div className="quick-menu wechat-menu">
          <button onClick={() => navigate({ name: 'qr', id: box.id })}>
            <QrCode size={18} />
            二维码
          </button>
          <button onClick={() => setEditingBox(true)}>
            <Edit3 size={18} />
            编辑箱子
          </button>
          <button
            onClick={() => {
              setClaimRecordsOpen(true);
              setShowBoxTools(false);
            }}
          >
            <Trash2 size={18} />
            领取记录
          </button>
          <button className="danger-text" onClick={handleArchive}>
            <Archive size={18} />
            归档箱子
          </button>
          <button className="danger-text" onClick={handleDeleteBox}>
            <Trash2 size={18} />
            删除箱子
          </button>
        </div>
      )}

      <section className="box-overview">
        <div>
          <span>物品</span>
          <strong>{boxItems.length}</strong>
        </div>
        <div>
          <span>低库存</span>
          <strong className={boxItems.some((item) => isLowStock(item, lowStockThreshold)) ? 'warning-text' : ''}>
            {boxItems.filter((item) => isLowStock(item, lowStockThreshold)).length}
          </strong>
        </div>
        <div>
          <span>库存</span>
          <strong>{boxItems.reduce((sum, item) => sum + item.quantity, 0)}</strong>
        </div>
      </section>

      <div className="detail-action-row">
        <button className="primary full" onClick={() => setEditingItem('new')}>
          <PackagePlus size={18} />
          添加物品
        </button>
      </div>

      {boxItems.length === 0 ? (
        <EmptyState
          title="没有物品"
          text="添加物品后，可以在这里直接入库和出库。"
        />
      ) : (
        <div className="card-list">
          {boxItems.map((item) => (
            <article className="item-card" key={item.id}>
              <div className="item-main">
                <CardPhoto imageDataUrl={item.imageDataUrl} alt={`${item.name} 图片`} className="item-photo" fallback={<PackagePlus size={24} />} />
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.specModel || '未填规格'}</span>
                </div>
                <b>{quantityText(item)}</b>
              </div>
              <div className="item-actions">
                <button className="success" onClick={() => setStockAction({ item, type: 'in' })}>
                  入库
                </button>
                <button className="danger-soft" onClick={() => setStockAction({ item, type: 'out' })}>
                  出库
                </button>
                <button className="ghost icon-only" onClick={() => setEditingItem(item)} aria-label="编辑物品">
                  <Edit3 size={17} />
                </button>
                <button
                  className="ghost icon-only danger-text"
                  onClick={async () => {
                    if (!confirm(`确认删除“${item.name}”？相关流水也会删除。`)) return;
                    await deleteItem(item);
                    await reload();
                    showToast({ type: 'success', message: '物品已删除' });
                  }}
                  aria-label="删除物品"
                >
                  <Trash2 size={17} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {editingBox && (
        <BoxFormDialog
          title="编辑箱子"
          box={box}
          onCancel={() => setEditingBox(false)}
          onSubmit={async (input) => {
            await updateBox(box, input);
            await reload();
            setEditingBox(false);
            showToast({ type: 'success', message: '箱子已更新' });
          }}
        />
      )}
      {editingItem && (
        <ItemFormDialog
          title={editingItem === 'new' ? '添加物品' : '编辑物品'}
          item={editingItem === 'new' ? undefined : editingItem}
          onCancel={() => setEditingItem(undefined)}
          onSubmit={async (input) => {
            if (editingItem === 'new') {
              await createItem({ ...input, boxId: box.id });
              showToast({ type: 'success', message: '物品已添加' });
            } else {
              await updateItem(editingItem, input);
              showToast({ type: 'success', message: '物品已更新' });
            }
            await reload();
            setEditingItem(undefined);
          }}
        />
      )}
      {stockAction && (
        <StockDialog
          item={stockAction.item}
          type={stockAction.type}
          onCancel={() => setStockAction(undefined)}
          onSubmit={async (quantity, input) => {
            await changeStock(stockAction.item, stockAction.type, quantity, input);
            await reload();
            setStockAction(undefined);
            showToast({
              type: 'success',
              message: `已${stockAction.type === 'in' ? '入库' : '出库'} ${quantityText({
                ...stockAction.item,
                quantity,
              })}`,
            });
          }}
        />
      )}
      {claimRecordsOpen && (
        <Dialog title="领取记录" onCancel={() => setClaimRecordsOpen(false)}>
          <ClaimRecordsPanel
            boxes={[box]}
            fixedBoxId={box.id}
            movements={movements}
            refresh={async () => {
              await reload();
            }}
            showToast={showToast}
            onDone={() => setClaimRecordsOpen(false)}
          />
        </Dialog>
      )}
    </section>
  );
}

function QrPage({
  box,
  navigate,
  showToast,
  refresh,
  online,
}: {
  box?: Box;
  navigate: (route: Route) => void;
  showToast: (toast: Toast) => void;
  refresh: () => Promise<void>;
  online: boolean;
}) {
  const [dataUrl, setDataUrl] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!box?.shareToken) {
      setDataUrl('');
      return;
    }
    createQrDataUrl(createShareQrValue(box))
      .then(setDataUrl)
      .catch((error) => showToast({ type: 'error', message: error.message }));
  }, [box?.code, box?.shareToken]);

  if (!box) {
    return (
      <section>
        <PageHeader title="二维码" back={() => navigate({ name: 'boxes' })} />
        <EmptyState title="箱子不存在" text="无法生成二维码。" />
      </section>
    );
  }

  const saveQrImage = async () => {
    if (!dataUrl) return;
    const safeName = `${box.code}-${box.name}.png`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || `${box.code}.png`;
    if (!box.shareToken) throw new Error('箱子尚未同步，暂时不能分享二维码');
    const labeledDataUrl = await createQrLabelDataUrl({ code: createShareQrValue(box), boxName: box.name });

    if (isNativeApp()) {
      setSaving(true);
      try {
        try {
          await saveDataUrlPhotoToGallery({ dataUrl: labeledDataUrl, fileName: safeName });
          showToast({ type: 'success', message: '二维码已保存到相册 老于智慧仓管' });
        } catch {
          await shareBase64File({
            base64: dataUrlToBase64(labeledDataUrl),
            fileName: safeName,
            title: safeName,
            text: `${box.name} ${box.code}`,
            dialogTitle: '保存或分享二维码',
          });
          showToast({ type: 'success', message: '已打开系统保存/分享面板' });
        }
      } catch (error) {
        if (error instanceof Error && /cancel/i.test(error.message)) {
          showToast({ type: 'error', message: '已取消保存' });
        } else {
          showToast({ type: 'error', message: error instanceof Error ? error.message : '二维码保存失败' });
        }
      } finally {
        setSaving(false);
      }
      return;
    }

    const a = document.createElement('a');
    a.href = labeledDataUrl;
    a.download = safeName;
    a.click();
  };

  return (
    <section>
      <PageHeader title="箱子二维码" subtitle={box.name} back={() => navigate({ name: 'box', id: box.id })} />
      {!box.shareToken && (
        <div className="sync-required-card">
          <CloudOff size={24} />
          <div><strong>分享二维码尚未生成</strong><p>这个箱子还没有同步到服务器。联网同步后，二维码将固定不变并可供他人只读查看。</p></div>
          <button
            className="primary"
            disabled={!online}
            onClick={() => refresh().catch((error) => showToast({ type: 'error', message: error.message }))}
          >
            立即同步
          </button>
        </div>
      )}
      <div className="qr-card">
        {dataUrl ? <img src={dataUrl} alt={`${box.name} 二维码`} /> : <div className="state-block">{box.shareToken ? '正在生成二维码...' : '等待云端同步'}</div>}
        <strong>{displayBoxCode(box.code)}</strong>
        <span>{box.name}</span>
      </div>
      <button
        className="primary full"
        disabled={!box.shareToken || !dataUrl || saving}
        onClick={() => saveQrImage().catch((error) => showToast({ type: 'error', message: error.message }))}
      >
        <Download size={18} />
        {saving ? '正在处理...' : '保存二维码图片'}
      </button>
    </section>
  );
}

function ScanPage({ navigate, showToast }: { navigate: (route: Route) => void; showToast: (toast: Toast) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | undefined>(undefined);
  const [manualCode, setManualCode] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [scanImageBusy, setScanImageBusy] = useState(false);
  const [status, setStatus] = useState('正在打开相机...');

  const openCode = async (code: string) => {
    if (!code.trim()) {
      setStatus('请输入箱码。');
      return;
    }
    const shared = parseShareQrValue(code);
    if (shared) {
      controlsRef.current?.stop();
      navigate({ name: 'shared', id: shared.boxId, token: shared.token });
      return;
    }
    const box = await getBoxByCode(code);
    if (!box) {
      setStatus('未找到箱子。');
      showToast({ type: 'error', message: '未找到箱子' });
      return;
    }
    controlsRef.current?.stop();
    navigate({ name: 'box', id: box.id });
  };

  useEffect(() => {
    let stopped = false;
    const reader = new BrowserQRCodeReader();
    const start = async () => {
      try {
        if (!videoRef.current) return;
        if (!isNativeApp() && !window.isSecureContext) {
          setStatus('相机不可用，可上传图片或输入箱码。');
          return;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          setStatus('浏览器不支持相机，可上传图片或输入箱码。');
          return;
        }
        controlsRef.current = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
          if (result && !stopped) {
            stopped = true;
            openCode(result.getText()).catch((error) => showToast({ type: 'error', message: error.message }));
          }
        });
        setStatus('请将箱子二维码放入取景框');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          setStatus('相机权限受限，可上传图片或输入箱码。');
        } else {
          setStatus('无法打开相机，可上传图片或输入箱码。');
        }
      }
    };
    start();
    return () => {
      stopped = true;
      controlsRef.current?.stop();
    };
  }, []);

  const scanImageFile = async (file?: File) => {
    if (!file) return;
    setScanImageBusy(true);
    const imageUrl = URL.createObjectURL(file);
    try {
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(imageUrl);
      await openCode(result.getText());
    } catch {
      setStatus('未识别到二维码。');
      showToast({ type: 'error', message: '未识别到二维码' });
    } finally {
      URL.revokeObjectURL(imageUrl);
      setScanImageBusy(false);
    }
  };

  return (
    <section className="scan-page">
      <PageHeader title="扫码查箱" />
      <div className="scan-panel">
        <div className="scanner">
          <video ref={videoRef} muted playsInline />
          <div className="scan-frame" />
        </div>
        <div className="scan-copy">
          <strong>对准箱子二维码</strong>
          <p>{status}</p>
        </div>
      </div>
      <div className="manual-scan">
        <div className="scan-actions">
          <label className="upload-choice scan-upload">
            <Upload size={18} />
            {scanImageBusy ? '识别中' : '上传图片'}
            <input
              type="file"
              accept="image/*"
              disabled={scanImageBusy}
              onChange={(event) => {
                scanImageFile(event.target.files?.[0]).catch((error) =>
                  showToast({ type: 'error', message: error instanceof Error ? error.message : '图片识别失败' }),
                );
                event.currentTarget.value = '';
              }}
            />
          </label>
          <button className="ghost full" onClick={() => setManualOpen((value) => !value)}>
            <Edit3 size={18} />
            输入箱码
          </button>
        </div>
        {manualOpen && (
          <div className="manual-entry">
            <label>
              箱子编码
              <input value={manualCode} onChange={(event) => setManualCode(event.target.value)} placeholder="箱码" />
            </label>
            <button className="primary full" onClick={() => openCode(manualCode)}>
              查找箱子
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function ToolsPage({
  boxes,
  items,
  movements,
  showToast,
  refresh,
  session,
  online,
  syncStatus,
}: {
  boxes: Box[];
  items: Item[];
  movements: StockMovement[];
  showToast: (toast: Toast) => void;
  refresh: () => Promise<void>;
  session: AuthSession;
  online: boolean;
  syncStatus: { queued: number; conflicts: number };
}) {
  const [mode, setMode] = useState<'hub' | 'profile' | 'export' | 'importBoxes' | 'backup' | 'movements'>('hub');
  const initialized = useRef(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(boxes.map((box) => box.id)));
  const [fileName, setFileName] = useState(defaultExportFileName());
  const [fileNameTouched, setFileNameTouched] = useState(false);
  const allSelected = selected.size === boxes.length && boxes.length > 0;

  useEffect(() => {
    if (initialized.current) return;
    setSelected(new Set(boxes.map((box) => box.id)));
    initialized.current = true;
  }, [boxes]);

  useEffect(() => {
    if (fileNameTouched) return;
    const selectedBoxes = boxes.filter((box) => selected.has(box.id));
    if (selectedBoxes.length === 1) {
      setFileName(defaultExportFileName(selectedBoxes[0].name));
    } else if (selectedBoxes.length > 1) {
      setFileName(defaultExportFileName('全部箱子'));
    } else {
      setFileName(defaultExportFileName());
    }
  }, [boxes, selected, fileNameTouched]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleExport = async () => {
    if (selected.size === 0) return;
    try {
      const result = await exportExcel({
        boxes,
        items,
        movements,
        selectedBoxIds: Array.from(selected),
        fileName,
        allSelected,
      });
      if (result.method === 'cancelled') {
        showToast({ type: 'error', message: '已取消导出' });
      } else if (result.method === 'download') {
        showToast({ type: 'success', message: 'Excel 已生成，请查看浏览器下载记录' });
      } else {
        showToast({ type: 'success', message: 'Excel 已生成，可在系统弹窗中保存或分享' });
      }
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : 'Excel 导出失败' });
    }
  };

  if (mode === 'export') {
    return (
      <section>
        <PageHeader title="导出" subtitle="选择要导出的箱子" back={() => setMode('hub')} />
        <div className="tool-section">
          <div className="section-title">
            <div>
              <h2>导出明细表</h2>
              <p>已选择 {selected.size} 个箱子</p>
            </div>
            <FileDown size={20} />
          </div>
          <label className="field">
            文件名
            <input
              value={fileName}
              onChange={(event) => {
                setFileNameTouched(true);
                setFileName(event.target.value);
              }}
            />
          </label>
          <div className="segmented compact">
            <button onClick={() => setSelected(new Set(boxes.map((box) => box.id)))}>全选</button>
            <button onClick={() => setSelected(new Set(boxes.filter((box) => !selected.has(box.id)).map((box) => box.id)))}>
              反选
            </button>
            <button onClick={() => setSelected(new Set())}>清空</button>
          </div>
          <div className="compact-check-list tall">
            {boxes.map((box) => (
              <label className="check-card" key={box.id}>
                <input type="checkbox" checked={selected.has(box.id)} onChange={() => toggle(box.id)} />
                <span>
                  <strong>{box.name}</strong>
                  <small>{displayBoxCode(box.code)}</small>
                </span>
              </label>
            ))}
          </div>
          <button className="primary full" disabled={selected.size === 0} onClick={handleExport}>
            <FileDown size={18} />
            导出 Excel
          </button>
        </div>
      </section>
    );
  }

  if (mode === 'profile') {
    return (
      <section>
        <PageHeader title="个人中心" subtitle="账号与同步设置" back={() => setMode('hub')} />
        <ProfilePanel session={session} online={online} syncStatus={syncStatus} showToast={showToast} />
      </section>
    );
  }

  if (mode === 'backup') {
    return (
      <section>
        <PageHeader title="备份" subtitle="换手机或清理前使用" back={() => setMode('hub')} />
        <BackupPanel boxes={boxes} items={items} movements={movements} refresh={refresh} showToast={showToast} />
      </section>
    );
  }

  if (mode === 'importBoxes') {
    return (
      <section>
        <PageHeader title="导入箱子" subtitle="从 Excel 新增箱子和物品" back={() => setMode('hub')} />
        <ImportBoxesPanel refresh={refresh} showToast={showToast} />
      </section>
    );
  }

  if (mode === 'movements') {
    return (
      <section>
        <PageHeader title="流水" subtitle={`${movements.length} 条出入库记录`} back={() => setMode('hub')} />
        <MovementHistoryPanel boxes={boxes} items={items} movements={movements} refresh={refresh} showToast={showToast} />
      </section>
    );
  }

  return (
    <section className="tool-hub-page">
      <PageHeader title="工具" subtitle="导出、导入、备份、流水" />
      <button className="profile-summary" onClick={() => setMode('profile')}>
        <span className="profile-avatar">{session.user.username.slice(0, 1).toUpperCase()}</span>
        <span>
          <strong>{session.user.username}</strong>
          <small>{online ? '云端在线，数据实时同步' : '当前离线，操作将在联网后同步'}</small>
        </span>
        <span className={`sync-dot ${online ? 'online' : 'offline'}`} />
        <ChevronRight size={20} />
      </button>
      <div className="tool-hub">
        <button className="tool-card" onClick={() => setMode('export')}>
          <span className="tool-card-icon">
            <FileDown size={22} />
          </span>
          <div>
            <strong>导出</strong>
            <small>选择箱子生成 Excel</small>
          </div>
          <ChevronRight size={20} />
        </button>
        <button className="tool-card" onClick={() => setMode('importBoxes')}>
          <span className="tool-card-icon">
            <Upload size={22} />
          </span>
          <div>
            <strong>导入箱子</strong>
            <small>从 Excel 一键导入</small>
          </div>
          <ChevronRight size={20} />
        </button>
        <button className="tool-card" onClick={() => setMode('backup')}>
          <span className="tool-card-icon">
            <Archive size={22} />
          </span>
          <div>
            <strong>备份</strong>
            <small>导出或恢复当前账号数据</small>
          </div>
          <ChevronRight size={20} />
        </button>
        <button className="tool-card" onClick={() => setMode('movements')}>
          <span className="tool-card-icon">
            <FileDown size={22} />
          </span>
          <div>
            <strong>流水</strong>
            <small>筛选查看全部记录</small>
          </div>
          <ChevronRight size={20} />
        </button>
      </div>
    </section>
  );
}

function ProfilePanel({
  session,
  online,
  syncStatus,
  showToast,
}: {
  session: AuthSession;
  online: boolean;
  syncStatus: { queued: number; conflicts: number };
  showToast: (toast: Toast) => void;
}) {
  const [username, setUsername] = useState(session.user.username);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setUsername(session.user.username);
  }, [session.user.username]);

  return (
    <div className="profile-page">
      <div className="profile-hero">
        <span className="profile-avatar large">{session.user.username.slice(0, 1).toUpperCase()}</span>
        <div>
          <strong>{session.user.username}</strong>
          <small>{online ? '云端同步已连接' : '当前离线，联网后自动同步'}</small>
        </div>
        <span className={`sync-dot ${online ? 'online' : 'offline'}`} style={{ flexShrink: 0 }} />
      </div>
      <div className="sync-overview">
        <div><strong className={online ? 'profile-stat-online' : 'profile-stat-offline'}>{online ? '在线' : '离线'}</strong><small>服务器连接</small></div>
        <div><strong>{syncStatus.queued}</strong><small>待同步操作</small></div>
        <div><strong className={syncStatus.conflicts > 0 ? 'warning-text' : ''}>{syncStatus.conflicts}</strong><small>同步冲突</small></div>
      </div>
      <form
        className="tool-section profile-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!currentPassword) {
            showToast({ type: 'error', message: '请输入当前密码确认修改' });
            return;
          }
          if (!/^[A-Za-z0-9_]{2,32}$/.test(username)) {
            showToast({ type: 'error', message: '账号需要 2-32 位，只能使用字母、数字或下划线' });
            return;
          }
          if (currentPassword.length < 6 || (newPassword && newPassword.length < 6)) {
            showToast({ type: 'error', message: '密码至少需要 6 位' });
            return;
          }
          setSaving(true);
          try {
            const next = await api.patch<AuthSession>('/auth/profile', {
              currentPassword,
              username,
              newPassword: newPassword || undefined,
            });
            setSession(next);
            setCurrentPassword('');
            setNewPassword('');
            showToast({ type: 'success', message: '账号信息已更新' });
          } catch (error) {
            showToast({ type: 'error', message: error instanceof Error ? error.message : '修改失败' });
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="section-title"><div><h2>账号信息</h2><p>修改时需要验证当前密码</p></div><UserRound size={20} /></div>
        <label className="field">账号<input value={username} onChange={(event) => setUsername(event.target.value.trim())} /></label>
        <label className="field">当前密码<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
        <label className="field">新密码（不修改可留空）<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
        <button className="primary full" disabled={saving || !online}>{saving ? '保存中...' : '保存修改'}</button>
      </form>
      <button
        className="danger full profile-logout"
        onClick={async () => {
          if (syncStatus.queued > 0 && !confirm(`还有 ${syncStatus.queued} 条操作尚未同步，退出后会丢弃。仍要退出吗？`)) return;
          try {
            await api.post('/auth/logout', { refreshToken: session.refreshToken });
          } catch {
            // Local logout must still work when the server is unavailable.
          }
          setSession(undefined);
        }}
      >
        退出登录
      </button>
    </div>
  );
}

function ClaimRecordsPanel({
  boxes,
  fixedBoxId,
  movements,
  refresh,
  showToast,
  onDone,
}: {
  boxes: Box[];
  fixedBoxId?: string;
  movements: StockMovement[];
  refresh: () => Promise<void>;
  showToast: (toast: Toast) => void;
  onDone?: () => void;
}) {
  const [boxId, setBoxId] = useState(fixedBoxId ?? boxes[0]?.id ?? '');
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set());
  const selectedBox = boxes.find((box) => box.id === boxId);
  const teamSummaries = useMemo(() => {
    const summary = new Map<string, { count: number; quantity: number }>();
    movements
      .filter((movement) => movement.boxId === boxId && movement.type === 'out' && !movement.exportExcluded)
      .forEach((movement) => {
        const team = movement.teamName?.trim() || '未填班组';
        const current = summary.get(team) ?? { count: 0, quantity: 0 };
        summary.set(team, { count: current.count + 1, quantity: current.quantity + movement.quantity });
      });
    return Array.from(summary, ([team, value]) => ({ team, ...value })).sort((a, b) => a.team.localeCompare(b.team, 'zh-CN'));
  }, [boxId, movements]);
  const selectedCount = teamSummaries
    .filter((entry) => selectedTeams.has(entry.team))
    .reduce((sum, entry) => sum + entry.count, 0);

  useEffect(() => {
    setSelectedTeams(new Set());
  }, [boxId]);

  useEffect(() => {
    if (boxId || boxes.length === 0) return;
    setBoxId(fixedBoxId ?? boxes[0].id);
  }, [boxId, boxes, fixedBoxId]);

  const toggleTeam = (team: string) => {
    const next = new Set(selectedTeams);
    if (next.has(team)) next.delete(team);
    else next.add(team);
    setSelectedTeams(next);
  };

  const clearSelected = async () => {
    const teams = Array.from(selectedTeams);
    if (!boxId || teams.length === 0) return;
    if (!confirm(`确认将“${selectedBox?.name ?? '当前箱子'}”中 ${teams.length} 个班组的 ${selectedCount} 条领取记录从 Excel 导出中清除？总流水仍会保留。`)) return;
    try {
      const removed = await excludeOutboundMovementsFromExcelByTeams({ boxId, teamNames: teams });
      await refresh();
      setSelectedTeams(new Set());
      showToast({ type: 'success', message: `已从 Excel 清除 ${removed} 条` });
      onDone?.();
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : '领取记录清除失败' });
    }
  };

  return (
    <div className="tool-section">
      <div className="section-title">
        <div>
          <h2>清除领取记录</h2>
          <p>只从 Excel 导出中清除，总流水保留</p>
        </div>
        <Trash2 size={20} />
      </div>
      {!fixedBoxId && (
        <label className="field">
          箱子
          <select value={boxId} onChange={(event) => setBoxId(event.target.value)}>
            {boxes.map((box) => (
              <option value={box.id} key={box.id}>
                {box.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="segmented compact">
        <button onClick={() => setSelectedTeams(new Set(teamSummaries.map((entry) => entry.team)))} disabled={teamSummaries.length === 0}>
          全选
        </button>
        <button
          onClick={() => setSelectedTeams(new Set(teamSummaries.filter((entry) => !selectedTeams.has(entry.team)).map((entry) => entry.team)))}
          disabled={teamSummaries.length === 0}
        >
          反选
        </button>
        <button onClick={() => setSelectedTeams(new Set())} disabled={selectedTeams.size === 0}>
          清空
        </button>
      </div>
      {teamSummaries.length === 0 ? (
        <p className="muted-line">这个箱子暂无可从 Excel 清除的领取记录。</p>
      ) : (
        <div className="compact-check-list tall">
          {teamSummaries.map((entry) => (
            <label className="check-card" key={entry.team}>
              <input type="checkbox" checked={selectedTeams.has(entry.team)} onChange={() => toggleTeam(entry.team)} />
              <span>
                <strong>{entry.team}</strong>
                <small>{entry.count} 条，合计 {entry.quantity}</small>
              </span>
            </label>
          ))}
        </div>
      )}
      <button className="danger full" disabled={!boxId || selectedTeams.size === 0} onClick={clearSelected}>
        <Trash2 size={18} />
        从 Excel 清除{selectedCount ? `（${selectedCount} 条）` : ''}
      </button>
    </div>
  );
}

function ImportBoxesPanel({
  refresh,
  showToast,
}: {
  refresh: () => Promise<void>;
  showToast: (toast: Toast) => void;
}) {
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState('');

  const handleFile = async (file?: File) => {
    if (!file) return;
    setImporting(true);
    try {
      const rows = await parseBoxesExcel(file);
      if (rows.length === 0) throw new Error('Excel 中没有可导入的箱子数据');
      const result = await importBoxesWithItems(rows);
      await refresh();
      const skipped = result.skippedBoxes.length ? `，跳过 ${result.skippedBoxes.length} 个已存在箱子` : '';
      const text = `导入 ${result.importedBoxes} 个箱子、${result.importedItems} 个物品${skipped}`;
      setSummary(text);
      showToast({ type: 'success', message: text });
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : '箱子导入失败' });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="tool-section">
      <div className="section-title">
        <div>
          <h2>导入箱子</h2>
          <p>支持列：箱子名称、箱子编码、物品类型、规格型号、数量、单位</p>
        </div>
        <Upload size={20} />
      </div>
      <label className="upload-btn full">
        <Upload size={18} />
        {importing ? '导入中' : '选择 Excel'}
        <input type="file" accept=".xlsx,.xls" disabled={importing} onChange={(event) => {
          handleFile(event.target.files?.[0]);
          event.currentTarget.value = '';
        }} />
      </label>
      {summary && <p className="muted-line">{summary}</p>}
    </div>
  );
}

function MovementHistoryPanel({
  boxes,
  items,
  movements,
  refresh,
  showToast,
}: {
  boxes: Box[];
  items: Item[];
  movements: StockMovement[];
  refresh: () => Promise<void>;
  showToast: (toast: Toast) => void;
}) {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [boxId, setBoxId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [editingMovement, setEditingMovement] = useState<StockMovement>();
  const teams = useMemo(
    () => Array.from(new Set(movements.map((movement) => movement.teamName).filter(Boolean) as string[])),
    [movements],
  );
  const filteredMovements = useMemo(() => {
    return movements.filter((movement) => {
      const date = movement.createdAt.slice(0, 10);
      const fromMatched = !fromDate || date >= fromDate;
      const toMatched = !toDate || date <= toDate;
      const boxMatched = !boxId || movement.boxId === boxId;
      const teamMatched = !teamName || movement.teamName === teamName;
      return fromMatched && toMatched && boxMatched && teamMatched;
    });
  }, [boxId, fromDate, movements, teamName, toDate]);
  const filterSummary = {
    fromDate,
    toDate,
    boxName: boxes.find((box) => box.id === boxId)?.name,
    teamName,
  };
  const handleExportMovements = async (scope: 'filtered' | 'all') => {
    const selectedMovements = scope === 'filtered' ? filteredMovements : movements;
    try {
      const result = await exportMovementsExcel({
        boxes,
        items,
        movements: selectedMovements,
        filterSummary: scope === 'filtered' ? filterSummary : undefined,
        fileName: defaultMovementExportFileName(scope === 'filtered' ? '筛选流水' : '全部流水'),
      });
      if (result.method !== 'cancelled') {
        showToast({ type: 'success', message: scope === 'filtered' ? '筛选流水已导出' : '全部流水已导出' });
      }
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : '流水导出失败' });
    }
  };

  return (
    <div className="tool-section">
      <div className="section-title">
        <div>
          <h2>全部流水</h2>
          <p>{filteredMovements.length} / {movements.length} 条记录</p>
        </div>
        <FileDown size={20} />
      </div>
      <div className="movement-filters">
        <label>
          开始
          <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>
        <label>
          结束
          <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </label>
        <label>
          箱子
          <select value={boxId} onChange={(event) => setBoxId(event.target.value)}>
            <option value="">全部</option>
            {boxes.map((box) => (
              <option value={box.id} key={box.id}>
                {box.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          班组
          <select value={teamName} onChange={(event) => setTeamName(event.target.value)}>
            <option value="">全部</option>
            {teams.map((team) => (
              <option value={team} key={team}>
                {team}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(fromDate || toDate || boxId || teamName) && (
        <button className="ghost full" onClick={() => {
          setFromDate('');
          setToDate('');
          setBoxId('');
          setTeamName('');
        }}>
          清除筛选
        </button>
      )}
      <div className="movement-export-actions">
        <button className="primary full" onClick={() => handleExportMovements('filtered')} disabled={filteredMovements.length === 0}>
          <Download size={18} />
          导出筛选
        </button>
        <button className="ghost full" onClick={() => handleExportMovements('all')} disabled={movements.length === 0}>
          <FileDown size={18} />
          导出全部
        </button>
      </div>
      {filteredMovements.length === 0 ? (
        <p className="muted-line">暂无出入库记录。</p>
      ) : (
        <div className="tool-movement-list">
          {filteredMovements.map((movement) => {
            const item = items.find((entry) => entry.id === movement.itemId);
            const box = boxes.find((entry) => entry.id === movement.boxId);
            const isOut = movement.type === 'out';
            return (
              <div className="movement-row" key={movement.id}>
                <div>
                  <strong>
                    {movementTypeText(movement.type)} · {itemTitle(item)}
                    <button className="inline-edit-btn" onClick={() => setEditingMovement(movement)}>
                      编辑
                    </button>
                  </strong>
                  <span>
                    {box?.name ?? '未知箱子'} · {movement.teamName ? `${movement.teamName} · ` : ''}
                    {formatDateOnly(movement.createdAt)}
                  </span>
                </div>
                <b className={isOut ? 'out' : 'in'}>
                  {isOut ? '-' : '+'}
                  {movement.quantity}
                </b>
              </div>
            );
          })}
        </div>
      )}
      {editingMovement && (
        <MovementEditDialog
          movement={editingMovement}
          item={items.find((entry) => entry.id === editingMovement.itemId)}
          onCancel={() => setEditingMovement(undefined)}
          onSubmit={async (input) => {
            await updateStockMovement(editingMovement, input);
            await refresh();
            setEditingMovement(undefined);
            showToast({ type: 'success', message: '流水已更新' });
          }}
        />
      )}
    </div>
  );
}

function MovementEditDialog({
  movement,
  item,
  onCancel,
  onSubmit,
}: {
  movement: StockMovement;
  item?: Item;
  onCancel: () => void;
  onSubmit: (input: { quantity: number; teamName?: string; note?: string; createdAt: string; imageDataUrl?: string }) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(String(movement.quantity));
  const [teamName, setTeamName] = useState(movement.teamName ?? '');
  const [createdAt, setCreatedAt] = useState(toDatetimeLocal(movement.createdAt));
  const [note, setNote] = useState(movement.note ?? '');
  const [imageDataUrl, setImageDataUrl] = useState(movement.imageDataUrl ?? '');
  const [saving, setSaving] = useState(false);
  const numericQuantity = Number(quantity);
  const invalid = quantity.trim() === '' || !Number.isFinite(numericQuantity) || numericQuantity < 0;

  return (
    <Dialog title={`编辑${movementTypeText(movement.type)}`} onCancel={onCancel}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (invalid) return;
          setSaving(true);
          try {
            await onSubmit({
              quantity: numericQuantity,
              teamName,
              note,
              imageDataUrl,
              createdAt: fromDatetimeLocal(createdAt),
            });
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="stock-preview">
          <span>物品</span>
          <strong>{itemTitle(item)}</strong>
        </div>
        <label className="field">
          数量{item?.unit ? `（${item.unit}）` : ''}
          <input autoFocus inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </label>
        {movement.type === 'out' && (
          <label className="field">
            领取班组
            <input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="班组" />
          </label>
        )}
        <label className="field">
          日期时间
          <input type="datetime-local" value={createdAt} onChange={(event) => setCreatedAt(event.target.value)} />
        </label>
        <label className="field">
          备注
          <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="备注" />
        </label>
        <ImagePicker
          label={movement.type === 'out' ? '出库照片' : movement.type === 'in' ? '入库照片' : '流水照片'}
          imageDataUrl={imageDataUrl}
          onChange={setImageDataUrl}
        />
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
          <button className="primary" disabled={invalid || saving}>
            保存
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function BackupPanel({
  boxes,
  items,
  movements,
  refresh,
  showToast,
}: {
  boxes: Box[];
  items: Item[];
  movements: StockMovement[];
  refresh: () => Promise<void>;
  showToast: (toast: Toast) => void;
}) {
  const [pendingBackup, setPendingBackup] = useState<BackupFile>();

  const handleFile = async (file?: File) => {
    if (!file) return;
    try {
      setPendingBackup(await parseBackupFile(file));
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : '备份文件读取失败' });
    }
  };

  return (
    <div className="tool-section">
      <div className="section-title">
        <div>
          <h2>备份恢复</h2>
          <p>换手机前先导出备份</p>
        </div>
        <Archive size={20} />
      </div>
      <div className="action-panel compact">
        <button
          className="primary full"
          onClick={() => exportBackup({ boxes, items, movements }).catch((error) =>
            showToast({ type: 'error', message: error instanceof Error ? error.message : '备份失败' }),
          )}
        >
          <Download size={18} />
          备份
        </button>
        <label className="upload-btn">
          <Upload size={18} />
          恢复
          <input type="file" accept="application/json" onChange={(event) => handleFile(event.target.files?.[0])} />
        </label>
      </div>
      {pendingBackup && (
        <div className="modal-backdrop">
          <div className="dialog">
            <h2>确认恢复备份</h2>
            <p>备份内包含 {pendingBackup.boxes.length} 个箱子、{pendingBackup.items.length} 个物品、{pendingBackup.movements.length} 条流水。</p>
            <p className="danger-text">恢复会覆盖当前账号的全部数据。</p>
            <div className="dialog-actions">
              <button className="ghost" onClick={() => setPendingBackup(undefined)}>
                取消
              </button>
              <button
                className="danger"
                onClick={async () => {
                  if (!confirm('再次确认：覆盖当前本地数据？')) return;
                  await restoreBackup(pendingBackup);
                  await refresh();
                  setPendingBackup(undefined);
                  showToast({ type: 'success', message: '备份已恢复' });
                }}
              >
                覆盖恢复
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BoxFormDialog({
  title,
  box,
  onCancel,
  onSubmit,
}: {
  title: string;
  box?: Box;
  onCancel: () => void;
  onSubmit: (input: { name: string; note?: string; imageDataUrl?: string }) => Promise<void>;
}) {
  const [name, setName] = useState(box?.name ?? '');
  const [note, setNote] = useState(box?.note ?? '');
  const [imageDataUrl, setImageDataUrl] = useState(box?.imageDataUrl ?? '');
  const [saving, setSaving] = useState(false);

  return (
    <Dialog title={title} onCancel={onCancel}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim()) return;
          setSaving(true);
          await onSubmit({ name, note, imageDataUrl });
          setSaving(false);
        }}
      >
        <label className="field">
          箱子名称
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="箱子名称" />
        </label>
        <label className="field">
          备注
          <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="备注" />
        </label>
        <ImagePicker label="箱子照片" imageDataUrl={imageDataUrl} onChange={setImageDataUrl} />
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
          <button className="primary" disabled={!name.trim() || saving}>
            保存
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ItemFormDialog({
  title,
  item,
  onCancel,
  onSubmit,
}: {
  title: string;
  item?: Item;
  onCancel: () => void;
  onSubmit: (input: {
    name: string;
    specModel?: string;
    quantity: number;
    unit?: string;
    lowStockThreshold?: number;
    imageDataUrl?: string;
    note?: string;
    createdAt?: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [specModel, setSpecModel] = useState(item?.specModel ?? '');
  const [quantity, setQuantity] = useState(item ? String(item.quantity) : '');
  const [unit, setUnit] = useState(item?.unit ?? '');
  const [lowStockThreshold, setLowStockThreshold] = useState(String(item?.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD));
  const [imageDataUrl, setImageDataUrl] = useState(item?.imageDataUrl ?? '');
  const [note, setNote] = useState(item?.note ?? '');
  const [createdAt, setCreatedAt] = useState(toDatetimeLocal(item?.createdAt));
  const [saving, setSaving] = useState(false);
  const numericQuantity = quantity.trim() === '' ? Number.NaN : Number(quantity);
  const numericLowStockThreshold = Number(lowStockThreshold);

  return (
    <Dialog title={title} onCancel={onCancel}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!name.trim() || !Number.isFinite(numericQuantity) || numericQuantity < 0) return;
          setSaving(true);
          await onSubmit({
            name,
            specModel,
            quantity: numericQuantity,
            unit,
            lowStockThreshold: Number.isFinite(numericLowStockThreshold) && numericLowStockThreshold >= 0 ? numericLowStockThreshold : DEFAULT_LOW_STOCK_THRESHOLD,
            imageDataUrl,
            note,
            createdAt: item ? undefined : fromDatetimeLocal(createdAt),
          });
          setSaving(false);
        }}
      >
        <label className="field">
          物品类型
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="物品名称" />
        </label>
        <label className="field">
          规格型号
          <input value={specModel} onChange={(event) => setSpecModel(event.target.value)} placeholder="规格" />
        </label>
        <div className="field-grid">
          <label className="field">
            {item ? '当前数量' : '入库数量'}
            <input inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          </label>
          <label className="field">
            单位
            <input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="个" />
          </label>
          <label className="field threshold-field">
            低库存
            <input inputMode="decimal" value={lowStockThreshold} onChange={(event) => setLowStockThreshold(event.target.value)} placeholder="2" />
          </label>
        </div>
        <div className="chip-row">
          {COMMON_UNITS.map((entry) => (
            <button type="button" className={unit === entry ? 'active' : ''} key={entry} onClick={() => setUnit(entry)}>
              {entry}
            </button>
          ))}
        </div>
        {!item && (
          <label className="field">
            入库时间
            <input type="datetime-local" value={createdAt} onChange={(event) => setCreatedAt(event.target.value)} />
          </label>
        )}
        <ImagePicker
          label={item ? '物品图片' : '入库拍照或上传图片'}
          imageDataUrl={imageDataUrl}
          onChange={setImageDataUrl}
        />
        <label className="field">
          备注
          <textarea value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
          <button className="primary" disabled={!name.trim() || !Number.isFinite(numericQuantity) || numericQuantity < 0 || numericLowStockThreshold < 0 || saving}>
            保存
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function StockDialog({
  item,
  type,
  onCancel,
  onSubmit,
}: {
  item: Item;
  type: 'in' | 'out';
  onCancel: () => void;
  onSubmit: (quantity: number, input: { note?: string; teamName?: string; createdAt: string; imageDataUrl?: string }) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState('');
  const [teamName, setTeamName] = useState('');
  const [teamSuggestions, setTeamSuggestions] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('teamSuggestions') || '[]');
    } catch {
      return [];
    }
  });
  const [createdAt, setCreatedAt] = useState(toDatetimeLocal());
  const [imageDataUrl, setImageDataUrl] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const value = Number(quantity);
  const after = type === 'in' ? item.quantity + value : item.quantity - value;
  const invalid = !Number.isFinite(value) || value <= 0 || after < 0;
  const submitStock = async () => {
    if (invalid) return;
    setSaving(true);
    if (type === 'out' && teamName.trim()) {
      const next = [teamName.trim(), ...teamSuggestions.filter((entry) => entry !== teamName.trim())].slice(0, 6);
      localStorage.setItem('teamSuggestions', JSON.stringify(next));
      setTeamSuggestions(next);
    }
    await onSubmit(value, { note, teamName, imageDataUrl, createdAt: fromDatetimeLocal(createdAt) });
    setSaving(false);
  };

  return (
    <Dialog title={`${type === 'in' ? '入库' : '出库'}：${item.name}`} onCancel={onCancel}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          await submitStock();
        }}
      >
        <label className="field">
          {type === 'in' ? '入库数量' : '出库数量'}
          <input autoFocus inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </label>
        {type === 'out' && (
          <label className="field">
            领取班组
            <input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="班组" />
          </label>
        )}
        {type === 'out' && teamSuggestions.length > 0 && (
          <div className="chip-row">
            {teamSuggestions.map((entry) => (
              <button type="button" className={teamName === entry ? 'active' : ''} key={entry} onClick={() => setTeamName(entry)}>
                {entry}
              </button>
            ))}
          </div>
        )}
        <label className="field">
          {type === 'in' ? '入库时间' : '领取时间'}
          <input type="datetime-local" value={createdAt} onChange={(event) => setCreatedAt(event.target.value)} />
        </label>
        <div className="stock-preview">
          <span>当前库存：{quantityText(item)}</span>
          <strong className={after < 0 ? 'danger-text' : ''}>操作后：{Number.isFinite(after) ? after : item.quantity}</strong>
        </div>
        {after < 0 && <p className="danger-text">出库数量不能超过当前库存。</p>}
        <ImagePicker
          label={type === 'in' ? '入库拍照或上传图片' : '出库拍照留存'}
          imageDataUrl={imageDataUrl}
          onChange={setImageDataUrl}
        />
        <label className="field">
          备注
          <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="备注" />
        </label>
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
          <button className={type === 'in' ? 'success' : 'danger'} disabled={invalid || saving}>
            确认{type === 'in' ? '入库' : '出库'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ImagePicker({
  label,
  imageDataUrl,
  onChange,
}: {
  label: string;
  imageDataUrl?: string;
  onChange: (value: string) => void;
}) {
  const handleFile = async (file?: File) => {
    if (!file) return;
    onChange(await fileToImageDataUrl(file));
  };

  return (
    <div className="image-picker">
      <span>{label}</span>
      {imageDataUrl && (
        <div className="image-preview">
          <CardPhoto imageDataUrl={imageDataUrl} alt={label} className="image-picker-photo" fallback={null} />
          <button type="button" className="ghost small" onClick={() => onChange('')}>
            移除图片
          </button>
        </div>
      )}
      <div className="image-actions">
        <label className="upload-choice">
          拍照
          <input type="file" accept="image/*" capture="environment" onChange={(event) => handleFile(event.target.files?.[0])} />
        </label>
        <label className="upload-choice">
          上传图片
          <input type="file" accept="image/*" onChange={(event) => handleFile(event.target.files?.[0])} />
        </label>
      </div>
    </div>
  );
}

function CardPhoto({
  imageDataUrl,
  alt,
  className,
  fallback,
}: {
  imageDataUrl?: string;
  alt: string;
  className: string;
  fallback: React.ReactNode;
}) {
  const [previewing, setPreviewing] = useState(false);

  if (!imageDataUrl) {
    return <span className={className} aria-hidden="true">{fallback}</span>;
  }

  return (
    <>
      <button
        type="button"
        className={`${className} previewable-photo`}
        aria-label={`查看${alt}`}
        onClick={(event) => {
          event.stopPropagation();
          setPreviewing(true);
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <img src={imageDataUrl} alt={alt} />
      </button>
      {previewing && (
        <div
          className="photo-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={(event) => {
            event.stopPropagation();
            setPreviewing(false);
          }}
        >
          <button type="button" className="photo-lightbox-close" aria-label="关闭照片" onClick={() => setPreviewing(false)}>
            ×
          </button>
          <img src={imageDataUrl} alt={alt} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </>
  );
}

function Dialog({ title, children, onCancel }: { title: string; children: React.ReactNode; onCancel: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="dialog">
        <div className="dialog-title">
          <h2>{title}</h2>
          <button className="ghost icon-only" onClick={onCancel} aria-label="关闭">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <Boxes size={42} />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
