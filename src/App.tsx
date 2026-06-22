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
  PackagePlus,
  Plus,
  QrCode,
  ScanLine,
  Search,
  Settings,
  Trash2,
  Upload,
} from 'lucide-react';
import type { AuthSession } from './lib/auth';
import type { BackupFile, Box, Item, SharedBox, StockMovement } from './types/domain';
import { formatDate, formatDateOnly, fromDatetimeLocal, toDatetimeLocal } from './lib/dates';
import { fileToImageDataUrl } from './lib/images';
import { parseBoxesExcel } from './lib/importBoxesExcel';
import { createQrDataUrl, createQrLabelDataUrl } from './lib/qr';
import { defaultAuditExportFileName, defaultExportFileName, defaultMovementExportFileName, exportAuditLogsExcel, exportExcel, exportMovementsExcel } from './lib/exportExcel';
import { AUDIT_ACTION_OPTIONS, auditActionLabel, type AuditLog } from './lib/auditActions';
import { exportBackup, parseBackupFile, restoreBackup } from './lib/backup';
import { dataUrlToBase64, isNativeApp, saveDataUrlPhotoToGallery, shareBase64File } from './lib/nativeFiles';
import { compareBoxCodes, displayBoxCode } from './lib/ids';
import { archiveBox, createBox, deleteBox, getBox, getBoxByCode, listBoxes, updateBox } from './repositories/boxes';
import { importBoxesWithItems } from './repositories/importBoxes';
import { changeStock, createItem, deleteItem, listAllItems, listItemsByBox, updateItem } from './repositories/items';
import { excludeOutboundMovementsFromExcelByTeams, listAllMovements, updateStockMovement } from './repositories/movements';
import { Capacitor } from '@capacitor/core';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { api, apiBase, hasApiConfiguration } from './lib/api';
import { getLocalDataOwner, getSession, onSessionChange, setSession } from './lib/auth';
import { clearLocalAccountData, cloudEnabled, createShareQrValue, getSharedBox, getSyncStatus, invalidateCloudData, parseShareQrValue } from './lib/cloud';
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

type ToolsTab = 'hub' | 'profile' | 'export' | 'importBoxes' | 'backup' | 'movements';

// 返回拦截器栈：浮层/弹窗打开时注册，按返回键先让最上层消费（关闭自己），再轮到路由返回
const backInterceptors: Array<() => boolean> = [];
const pushBackInterceptor = (fn: () => boolean) => {
  backInterceptors.push(fn);
  return () => {
    const index = backInterceptors.indexOf(fn);
    if (index >= 0) backInterceptors.splice(index, 1);
  };
};
const runBackInterceptors = () => {
  for (let i = backInterceptors.length - 1; i >= 0; i -= 1) {
    if (backInterceptors[i]!()) return true;
  }
  return false;
};

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

// 底部标签栏只在一级页面显示；进入箱子详情、二维码等二级页面时隐藏
const TOP_LEVEL_ROUTES = new Set<Route['name']>(['home', 'scan', 'boxes', 'tools']);

const TOAST_DURATION_MS = 1800;
const CLOUD_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const quantityText = (item: Item) => `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`;
const itemTitle = (item?: Item) => item?.name ?? '已删除物品';
const COMMON_UNITS = ['个', '套', '米', '箱', '瓶', '件', '片', '根', '把', '只', '盒', '付', '台', '双', '包'];
// 累计入库数量：该物品历史上每一次库存增加之和（入库 + 向上调整，含初始库存）。
// 用 max(0, 后-前) 统计正向增量，出库/向下调整不计入。
const cumulativeInbound = (itemId: string, movements: StockMovement[]) =>
  movements.reduce(
    (sum, m) => (m.itemId === itemId ? sum + Math.max(0, m.afterQuantity - m.beforeQuantity) : sum),
    0,
  );
const todayKey = () => new Date().toLocaleDateString('sv-SE');
const movementTypeText = (type: StockMovement['type']) => (type === 'out' ? '出库' : type === 'in' ? '入库' : '调整');

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [toolsTab, setToolsTab] = useState<ToolsTab>('hub');
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<Toast>();
  const toastTimerRef = useRef<number | undefined>(undefined);
  const [session, setAuthSession] = useState<AuthSession | undefined>(getSession);
  const [syncStatus, setSyncStatus] = useState({ queued: 0, conflicts: 0 });
  const [online, setOnline] = useState(navigator.onLine);
  const [appVersion, setAppVersion] = useState<string>(() =>
    Capacitor.isNativePlatform() ? (localStorage.getItem('app-last-version') ?? '') : ''
  );
  const [updateInfo, setUpdateInfo] = useState<{ version: string; changelog?: string } | undefined>();
  const [lastSyncTime, setLastSyncTime] = useState<Date | undefined>(() => {
    const s = localStorage.getItem('last-sync-time');
    return s ? new Date(s) : undefined;
  });

  const showToast = (next: Toast) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(next);
    toastTimerRef.current = window.setTimeout(() => setToast(undefined), TOAST_DURATION_MS);
  };

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !apiBase) return;
    (async () => {
      try {
        const { bundle } = await CapacitorUpdater.current();
        const lastVersion = localStorage.getItem('app-last-version') ?? '';

        // Just updated — show changelog dialog
        if (bundle.version !== 'builtin' && bundle.version !== lastVersion) {
          localStorage.setItem('app-last-version', bundle.version);
          setAppVersion(bundle.version);
          try {
            const vres = await fetch(`${apiBase}/bundles/version.json`, { cache: 'no-store' });
            const vdata = vres.ok ? await vres.json() as { version: string; changelog?: string } : {};
            setUpdateInfo({ version: bundle.version, changelog: (vdata as { changelog?: string }).changelog });
          } catch {
            setUpdateInfo({ version: bundle.version });
          }
          return;
        }

        if (!lastVersion && bundle.version !== 'builtin') {
          localStorage.setItem('app-last-version', bundle.version);
          setAppVersion(bundle.version);
        }

        // Check for new version
        const res = await fetch(`${apiBase}/bundles/version.json`, { cache: 'no-store' });
        if (!res.ok) return;
        const { version, url } = await res.json() as { version: string; url?: string };
        if (!url || !version || version === '0.0.0' || version === bundle.version) return;
        showToast({ type: 'success', message: `发现新版本 ${version}，正在更新...` });
        const newBundle = await CapacitorUpdater.download({ url, version });
        await CapacitorUpdater.set(newBundle);
      } catch {
        // ignore
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncData = async () => {
    const [boxRows, itemRows, movementRows] = await Promise.all([
      listBoxes(),
      listAllItems(),
      listAllMovements(),
    ]);
    setBoxes(boxRows);
    setItems(itemRows);
    setMovements(movementRows);
    setSyncStatus(await getSyncStatus());
    if (cloudEnabled()) {
      const now = new Date();
      setLastSyncTime(now);
      localStorage.setItem('last-sync-time', now.toISOString());
    }
  };

  const loadAll = async () => {
    setLoading(true);
    try {
      await syncData();
    } finally {
      setLoading(false);
    }
  };

  const navigate = (next: Route) => {
    setToolsTab('hub');
    history.pushState({ route: next }, '', routeToHash(next));
    setRoute(next);
  };

  // refs 让原生返回回调始终读到最新值，避免闭包过期
  const routeRef = useRef(route);
  routeRef.current = route;
  const toolsTabRef = useRef(toolsTab);
  toolsTabRef.current = toolsTab;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // 计算返回上一级；返回 false 表示已在顶层（首页），调用方应退出 app
  const goBack = (): boolean => {
    if (runBackInterceptors()) return true;
    const r = routeRef.current;
    if (r.name === 'tools' && toolsTabRef.current !== 'hub') {
      setToolsTab('hub');
      return true;
    }
    if (r.name === 'box') {
      navigateRef.current({ name: 'boxes' });
      return true;
    }
    if (r.name === 'qr') {
      navigateRef.current({ name: 'box', id: r.id });
      return true;
    }
    if (r.name === 'home') return false;
    navigateRef.current({ name: 'home' });
    return true;
  };
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;

  useEffect(() => {
    // 记录初始状态，确保 popstate 始终有 state 可恢复
    history.replaceState({ route: parseRoute() }, '', window.location.href);

    const handlePopState = (event: PopStateEvent) => {
      if (event.state?.route) {
        setRoute(event.state.route as Route);
      } else {
        // 弹到了 app 启动前的历史项（无 state）——推回首页 sentinel，防止下一次返回退出 app
        history.pushState({ route: { name: 'home' } }, '', '#/');
        setRoute({ name: 'home' });
      }
    };

    window.addEventListener('popstate', handlePopState);
    loadAll().catch((error) => showToast({ type: 'error', message: error.message }));
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // 原生安卓返回键 / 全面屏返回手势：返回上一级，仅在首页时退出 app
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let remove: (() => void) | undefined;
    import('@capacitor/app').then(({ App: CapApp }) => {
      CapApp.addListener('backButton', () => {
        if (!goBackRef.current()) CapApp.exitApp();
      }).then((handle) => {
        remove = () => handle.remove();
      });
    });
    return () => remove?.();
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
      if (navigator.onLine && getSession()) syncData().catch(() => undefined);
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => syncData().catch(() => undefined), CLOUD_SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const currentBox = route.name === 'box' || route.name === 'qr' ? boxes.find((box) => box.id === route.id) : undefined;

  if (!session && route.name !== 'scan' && route.name !== 'shared') {
    return <AuthPage navigate={navigate} showToast={showToast} />;
  }

  const UpdateDialog = updateInfo && (
    <div className="update-backdrop" onClick={() => setUpdateInfo(undefined)}>
      <div className="update-modal" onClick={(e) => e.stopPropagation()}>
        <div className="update-modal-icon"><Boxes size={22} /></div>
        <h2>已更新到 v{updateInfo.version}</h2>
        {updateInfo.changelog
          ? <div className="update-changelog">{updateInfo.changelog.split('\n').filter(Boolean).map((line, i) => <p key={i}>{line}</p>)}</div>
          : <p className="update-desc">App 已在后台自动更新完成。</p>
        }
        <button className="update-close" onClick={() => setUpdateInfo(undefined)}>知道了</button>
      </div>
    </div>
  );

  if (session?.user.isAdmin) {
    return (
      <div className="app-shell">
        {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
        {UpdateDialog}
        <AdminPanel session={session} showToast={showToast} />
      </div>
    );
  }

  const showBottomNav =
    Boolean(session) &&
    TOP_LEVEL_ROUTES.has(route.name) &&
    !(route.name === 'tools' && toolsTab !== 'hub');

  return (
    <div className="app-shell">
      {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
      {UpdateDialog}
      <main className={`app-main${showBottomNav ? '' : ' no-bottom-nav'}`}>
        {loading && <div className="state-block">正在读取本地数据...</div>}
        {!loading && route.name === 'home' && (
          <HomePage
            boxes={boxes}
            items={items}
            movements={movements}
            navigate={navigate}
            refresh={syncData}
            showToast={showToast}
            online={online}
            lastSyncTime={lastSyncTime}
          />
        )}
        {!loading && route.name === 'boxes' && (
          <BoxListPage
            boxes={boxes}
            items={items}
            navigate={navigate}
            refresh={syncData}
            showToast={showToast}
          />
        )}
        {!loading && route.name === 'box' && (
          <BoxDetailPage
            box={currentBox}
            movements={movements}
            navigate={navigate}
            refresh={syncData}
            showToast={showToast}
          />
        )}
        {!loading && route.name === 'qr' && (
          <QrPage box={currentBox} navigate={navigate} showToast={showToast} refresh={syncData} online={online} />
        )}
        {!loading && route.name === 'scan' && <ScanPage navigate={navigate} showToast={showToast} />}
        {!loading && route.name === 'shared' && <SharedBoxPage id={route.id} token={route.token} navigate={navigate} showToast={showToast} />}
        {!loading && route.name === 'tools' && (
          <ToolsPage
            boxes={boxes}
            items={items}
            movements={movements}
            showToast={showToast}
            refresh={syncData}
            session={session!}
            online={online}
            syncStatus={syncStatus}
            appVersion={appVersion}
            tab={toolsTab}
            onTab={setToolsTab}
          />
        )}
      </main>
      {showBottomNav && <BottomNav route={route} navigate={navigate} />}
    </div>
  );
}

type AdminUser = { id: string; username: string; createdAt: string };
type LoginLog = { id: string; username: string; ip: string | null; success: boolean; createdAt: string };

function AdminPanel({ session, showToast }: { session: AuthSession; showToast: (t: Toast) => void }) {
  const [tab, setTab] = useState<'users' | 'logs' | 'audit'>('users');
  const [userList, setUserList] = useState<AdminUser[]>([]);
  const [logs, setLogs] = useState<LoginLog[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [resetTarget, setResetTarget] = useState<AdminUser | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | undefined>();
  const [deleting, setDeleting] = useState(false);
  const [newPwd, setNewPwd] = useState('');
  const [resetting, setResetting] = useState(false);
  const [logDetail, setLogDetail] = useState<LoginLog | undefined>();
  const [auditDetail, setAuditDetail] = useState<AuditLog | undefined>();
  const [auditFilter, setAuditFilter] = useState<{ userId: string; action: string; fromDate: string; toDate: string }>({
    userId: '', action: '', fromDate: '', toDate: '',
  });

  // 用户列表始终加载：用户管理页和操作日志的「按用户筛选」都要用
  useEffect(() => {
    api.get<AdminUser[]>('/admin/users').then(setUserList).catch(() => undefined);
  }, []);

  const loadAudit = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (auditFilter.userId) params.set('userId', auditFilter.userId);
    if (auditFilter.action) params.set('action', auditFilter.action);
    if (auditFilter.fromDate) params.set('fromDate', auditFilter.fromDate);
    if (auditFilter.toDate) params.set('toDate', auditFilter.toDate);
    api.get<AuditLog[]>(`/admin/audit-logs?${params.toString()}`)
      .then(setAuditLogs)
      .catch((e) => showToast({ type: 'error', message: e instanceof Error ? e.message : '加载失败' }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (tab === 'users') {
      setLoading(true);
      api.get<AdminUser[]>('/admin/users').then(setUserList)
        .catch((e) => showToast({ type: 'error', message: e instanceof Error ? e.message : '加载失败' }))
        .finally(() => setLoading(false));
    } else if (tab === 'logs') {
      setLoading(true);
      api.get<LoginLog[]>('/admin/login-logs').then(setLogs)
        .catch((e) => showToast({ type: 'error', message: e instanceof Error ? e.message : '加载失败' }))
        .finally(() => setLoading(false));
    } else {
      loadAudit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, auditFilter]);

  const handleReset = async () => {
    if (!resetTarget || !newPwd || newPwd.length < 6) return;
    setResetting(true);
    try {
      await api.post(`/admin/users/${resetTarget.id}/reset-password`, { newPassword: newPwd });
      showToast({ type: 'success', message: `${resetTarget.username} 密码已重置` });
      setResetTarget(undefined);
      setNewPwd('');
    } catch (e) {
      showToast({ type: 'error', message: e instanceof Error ? e.message : '重置失败' });
    } finally {
      setResetting(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.post(`/admin/users/${deleteTarget.id}/delete`, {});
      showToast({ type: 'success', message: `已删除用户 ${deleteTarget.username}` });
      setUserList((list) => list.filter((u) => u.id !== deleteTarget.id));
      setDeleteTarget(undefined);
    } catch (e) {
      showToast({ type: 'error', message: e instanceof Error ? e.message : '删除失败' });
    } finally {
      setDeleting(false);
    }
  };

  const handleExportAudit = async () => {
    if (auditLogs.length === 0) return;
    try {
      const parts = [
        auditFilter.userId ? `用户：${userList.find((u) => u.id === auditFilter.userId)?.username ?? ''}` : '',
        auditFilter.action ? `类型：${auditActionLabel(auditFilter.action)}` : '',
        auditFilter.fromDate ? `自 ${auditFilter.fromDate}` : '',
        auditFilter.toDate ? `至 ${auditFilter.toDate}` : '',
      ].filter(Boolean);
      const result = await exportAuditLogsExcel({
        logs: auditLogs,
        fileName: defaultAuditExportFileName(),
        filterSummary: parts.length ? parts.join('  ') : `共 ${auditLogs.length} 条记录`,
      });
      if (result.method !== 'cancelled') {
        await api.post('/audit', { action: 'export.audit', detail: `导出操作日志 ${auditLogs.length} 条` }).catch(() => undefined);
        showToast({ type: 'success', message: '操作日志已导出' });
      }
    } catch (e) {
      showToast({ type: 'error', message: e instanceof Error ? e.message : '导出失败' });
    }
  };

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-icon"><Boxes size={20} /></div>
        <div className="admin-header-text">
          <h1>管理员后台</h1>
          <p>老于智慧仓管</p>
        </div>
        <button
          className="admin-logout"
          onClick={async () => {
            try { await api.post('/auth/logout', { refreshToken: session.refreshToken }); } catch { /* ignore */ }
            setSession(undefined);
          }}
        >退出登录</button>
      </header>

      <div className="admin-tab-bar">
        <div className="admin-tab-control">
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>用户管理</button>
          <button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>登录日志</button>
          <button className={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>操作日志</button>
        </div>
      </div>

      {loading && (
        <div className="admin-state">
          <div className="admin-state-dot" />
          加载中...
        </div>
      )}

      {!loading && tab === 'users' && (
        <div className="admin-list">
          {userList.length === 0
            ? <div className="admin-empty"><span>暂无普通用户</span></div>
            : userList.map((u) => (
              <div key={u.id} className="admin-row">
                <span className="admin-avatar">{u.username.slice(0, 1).toUpperCase()}</span>
                <div className="admin-row-info">
                  <strong>{u.username}</strong>
                  <small>注册于 {new Date(u.createdAt).toLocaleDateString('zh-CN')}</small>
                </div>
                <button className="admin-action" onClick={() => { setResetTarget(u); setNewPwd(''); }}>重置密码</button>
                <button className="admin-action danger" onClick={() => setDeleteTarget(u)}>删除</button>
              </div>
            ))
          }
        </div>
      )}

      {!loading && tab === 'logs' && (
        <div className="admin-list">
          {logs.length === 0
            ? <div className="admin-empty"><span>暂无登录记录</span></div>
            : logs.map((log) => (
              <div key={log.id} className="admin-row admin-row-clickable" onClick={() => setLogDetail(log)}>
                <span className={`admin-avatar ${log.success ? 'success' : 'fail'}`}>
                  {log.username.slice(0, 1).toUpperCase()}
                </span>
                <div className="admin-row-info">
                  <strong>{log.username}</strong>
                  <small>{new Date(log.createdAt).toLocaleString('zh-CN')} · {log.ip ?? '未知 IP'}</small>
                </div>
                <span className={`admin-badge ${log.success ? 'success' : 'fail'}`}>{log.success ? '成功' : '失败'}</span>
              </div>
            ))
          }
        </div>
      )}

      {tab === 'audit' && (
        <>
          <div className="admin-audit-filters">
            <select value={auditFilter.userId} onChange={(e) => setAuditFilter((f) => ({ ...f, userId: e.target.value }))}>
              <option value="">全部用户</option>
              {userList.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
            </select>
            <select value={auditFilter.action} onChange={(e) => setAuditFilter((f) => ({ ...f, action: e.target.value }))}>
              <option value="">全部操作</option>
              {AUDIT_ACTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input type="date" value={auditFilter.fromDate} onChange={(e) => setAuditFilter((f) => ({ ...f, fromDate: e.target.value }))} />
            <input type="date" value={auditFilter.toDate} onChange={(e) => setAuditFilter((f) => ({ ...f, toDate: e.target.value }))} />
          </div>
          <div className="admin-audit-actions">
            {(auditFilter.userId || auditFilter.action || auditFilter.fromDate || auditFilter.toDate) && (
              <button className="admin-action" onClick={() => setAuditFilter({ userId: '', action: '', fromDate: '', toDate: '' })}>清除筛选</button>
            )}
            <button className="admin-action primary" onClick={handleExportAudit} disabled={auditLogs.length === 0}>导出 Excel</button>
          </div>
          {!loading && (
            <div className="admin-list">
              {auditLogs.length === 0
                ? <div className="admin-empty"><span>暂无操作记录</span></div>
                : auditLogs.map((log) => (
                  <div key={log.id} className="admin-row admin-row-clickable" onClick={() => setAuditDetail(log)}>
                    <span className="admin-avatar">{log.username.slice(0, 1).toUpperCase()}</span>
                    <div className="admin-row-info">
                      <strong>{log.username} · {auditActionLabel(log.action)}</strong>
                      <small>{log.detail ?? ''}</small>
                      <small>{new Date(log.createdAt).toLocaleString('zh-CN', { hour12: false })} · {log.ip ?? '未知 IP'}</small>
                    </div>
                  </div>
                ))
              }
            </div>
          )}
        </>
      )}

      {resetTarget && (
        <div className="admin-modal-backdrop" onClick={() => setResetTarget(undefined)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-icon">
              <span>{resetTarget.username.slice(0, 1).toUpperCase()}</span>
            </div>
            <h2>重置密码</h2>
            <p>为账号 <strong>{resetTarget.username}</strong> 设置新密码，重置后该账号所有在线设备将被踢下线。</p>
            <input
              className="admin-input"
              type="password"
              placeholder="新密码（至少 6 位）"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              autoFocus
            />
            <div className="admin-modal-actions">
              <button className="admin-cancel" onClick={() => setResetTarget(undefined)}>取消</button>
              <button className="admin-confirm" disabled={newPwd.length < 6 || resetting} onClick={handleReset}>
                {resetting ? '提交中...' : '确认重置'}
              </button>
            </div>
          </div>
        </div>
      )}

      {logDetail && (
        <div className="admin-modal-backdrop" onClick={() => setLogDetail(undefined)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className={`admin-modal-icon ${logDetail.success ? 'success' : 'fail'}`}>
              {logDetail.username.slice(0, 1).toUpperCase()}
            </div>
            <h2>{logDetail.success ? '登录成功' : '登录失败'}</h2>
            <div className="admin-log-detail">
              <div className="admin-log-detail-row">
                <span>账号</span>
                <strong>{logDetail.username}</strong>
              </div>
              <div className="admin-log-detail-row">
                <span>时间</span>
                <strong>{new Date(logDetail.createdAt).toLocaleString('zh-CN', { hour12: false })}</strong>
              </div>
              <div className="admin-log-detail-row">
                <span>IP 地址</span>
                <strong>{logDetail.ip ?? '未记录'}</strong>
              </div>
              <div className="admin-log-detail-row">
                <span>结果</span>
                <span className={`admin-badge ${logDetail.success ? 'success' : 'fail'}`}>
                  {logDetail.success ? '登录成功' : '登录失败'}
                </span>
              </div>
            </div>
            <button className="admin-confirm admin-confirm-full" onClick={() => setLogDetail(undefined)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="admin-modal-backdrop" onClick={() => setDeleteTarget(undefined)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-icon fail">{deleteTarget.username.slice(0, 1).toUpperCase()}</div>
            <h2>删除用户</h2>
            <p>确认删除账号 <strong>{deleteTarget.username}</strong>？该用户的<strong>全部箱子、物品和流水都会一并永久删除</strong>，不可恢复。</p>
            <div className="admin-modal-actions">
              <button className="admin-cancel" onClick={() => setDeleteTarget(undefined)}>取消</button>
              <button className="admin-confirm danger" disabled={deleting} onClick={handleDeleteUser}>
                {deleting ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {auditDetail && (
        <div className="admin-modal-backdrop" onClick={() => setAuditDetail(undefined)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-icon"><span>{auditDetail.username.slice(0, 1).toUpperCase()}</span></div>
            <h2>{auditActionLabel(auditDetail.action)}</h2>
            <div className="admin-log-detail">
              <div className="admin-log-detail-row"><span>操作人</span><strong>{auditDetail.username}</strong></div>
              <div className="admin-log-detail-row"><span>时间</span><strong>{new Date(auditDetail.createdAt).toLocaleString('zh-CN', { hour12: false })}</strong></div>
              <div className="admin-log-detail-row"><span>详情</span><strong>{auditDetail.detail ?? '—'}</strong></div>
              <div className="admin-log-detail-row"><span>IP 地址</span><strong>{auditDetail.ip ?? '未记录'}</strong></div>
            </div>
            <button className="admin-confirm admin-confirm-full" onClick={() => setAuditDetail(undefined)}>关闭</button>
          </div>
        </div>
      )}
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
            <input autoCapitalize="none" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value.trim())} placeholder="账号（字母、数字或下划线）" />
          </label>
          <label className="auth-field">
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
  online,
  lastSyncTime,
}: {
  boxes: Box[];
  items: Item[];
  movements: StockMovement[];
  navigate: (route: Route) => void;
  refresh: () => Promise<void>;
  showToast: (toast: Toast) => void;
  online: boolean;
  lastSyncTime?: Date;
}) {
  const [creating, setCreating] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const totalStock = items.reduce((sum, item) => sum + item.quantity, 0);
  const todayMovements = movements.filter((movement) => movement.createdAt.slice(0, 10) === todayKey()).length;
  const todayIn = movements.filter((movement) => movement.createdAt.slice(0, 10) === todayKey() && movement.type === 'in').length;
  const todayOut = movements.filter((movement) => movement.createdAt.slice(0, 10) === todayKey() && movement.type === 'out').length;
  const visibleBoxes = useMemo(() => boxes.slice(0, 3), [boxes]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return items
      .filter((item) =>
        item.name.toLowerCase().includes(q) ||
        (item.specModel ?? '').toLowerCase().includes(q) ||
        (item.note ?? '').toLowerCase().includes(q),
      )
      .map((item) => ({ item, box: boxes.find((b) => b.id === item.boxId) }))
      .sort((a, b) => compareBoxCodes(a.box?.code ?? '', b.box?.code ?? ''));
  }, [searchQuery, items, boxes]);

  const closeSearch = () => { setSearchOpen(false); setSearchQuery(''); };

  // 搜索浮层打开时，按返回键先关闭浮层而不是退出 app
  useEffect(() => {
    if (!searchOpen) return;
    return pushBackInterceptor(() => { closeSearch(); return true; });
  }, [searchOpen]);

  const handleCreate = async (input: { name: string; note?: string; imageDataUrl?: string }) => {
    try {
      const box = await createBox(input);
      await refresh();
      setCreating(false);
      showToast({ type: 'success', message: `已创建 ${box.name}` });
      navigate({ name: 'box', id: box.id });
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : '创建失败' });
    }
  };

  return (
    <section className="home-page">
      <header className="home-header">
        <div>
          <h1>老于智慧仓管</h1>
          <p className={`home-sync ${online ? 'online' : 'offline'}`}>
            <span />
            {online
              ? lastSyncTime
                ? `${formatDateOnly(lastSyncTime.toISOString())} ${lastSyncTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 已同步`
                : '正在同步...'
              : '离线使用，联网后自动同步'}
          </p>
        </div>
        <button className="ghost icon-only" onClick={() => setSearchOpen(true)} aria-label="搜索物品">
          <Search size={22} />
        </button>
      </header>

      {searchOpen && (
        <div className="search-overlay">
          <div className="search-bar">
            <Search size={18} />
            <input
              autoFocus
              placeholder="搜索物品名称、规格..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button onClick={closeSearch}>取消</button>
          </div>
          <div className="search-results">
            {searchQuery.trim() === '' ? (
              <p className="search-hint">输入物品名称或规格型号</p>
            ) : searchResults.length === 0 ? (
              <p className="search-hint">未找到"<b>{searchQuery.trim()}</b>"</p>
            ) : (
              <>
                <p className="search-count">{searchResults.length} 个结果</p>
                {searchResults.map(({ item, box }) => (
                  <div
                    key={item.id}
                    className="search-result-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => { if (box) navigate({ name: 'box', id: box.id }); closeSearch(); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { if (box) navigate({ name: 'box', id: box.id }); closeSearch(); } }}
                  >
                    <div className="search-result-main">
                      <strong>{item.name}</strong>
                      {item.specModel && <span className="search-spec">{item.specModel}</span>}
                    </div>
                    <div className="search-result-meta">
                      <span className="search-box-tag">{box?.name ?? '未知箱子'}</span>
                      <span className="search-qty">{quantityText(item)}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      <div className="overview-strip">
        <StatPill icon={<Boxes size={28} />} label="箱子" value={boxes.length} />
        <StatPill icon={<PackagePlus size={27} />} label="物品" value={items.length} />
        <StatPill icon={<Archive size={27} />} label="总库存" value={totalStock} />
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
}: {
  boxes: Box[];
  items: Item[];
  navigate: (route: Route) => void;
  refresh: () => Promise<void>;
  showToast: (toast: Toast) => void;
}) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
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
    const rows = boxes.filter(
      (box) => !text || `${box.name} ${box.code} ${box.note ?? ''}`.toLowerCase().includes(text),
    );
    return rows.sort((a, b) => compareBoxCodes(a.code, b.code));
  }, [boxes, query]);

  const handleCreate = async (input: { name: string; note?: string; imageDataUrl?: string }) => {
    try {
      const box = await createBox(input);
      await refresh();
      setCreating(false);
      showToast({ type: 'success', message: `已创建 ${box.name}` });
      navigate({ name: 'box', id: box.id });
    } catch (error) {
      showToast({ type: 'error', message: error instanceof Error ? error.message : '创建失败' });
    }
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
      {filtered.length === 0 ? (
        <EmptyState title="还没有箱子" text="先创建一个箱子，再添加物品和生成二维码。" />
      ) : (
        <div className="card-list">
          {filtered.map((box) => {
            const boxItems = itemsByBox.get(box.id) ?? [];
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
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Fab onClick={() => setCreating(true)} />
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
}: {
  box?: Box;
  movements: StockMovement[];
  navigate: (route: Route) => void;
  refresh: () => Promise<void>;
  showToast: (toast: Toast) => void;
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
          <span>库存</span>
          <strong>{boxItems.reduce((sum, item) => sum + item.quantity, 0)}</strong>
        </div>
        <div>
          <span>累计入库</span>
          <strong>{boxItems.reduce((sum, item) => sum + cumulativeInbound(item.id, movements), 0)}</strong>
        </div>
      </section>

      <Fab onClick={() => setEditingItem('new')} />

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
                  <small className="item-inbound">累计入库 {cumulativeInbound(item.id, movements)}</small>
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
            try {
              await updateBox(box, input);
              await reload();
              setEditingBox(false);
              showToast({ type: 'success', message: '箱子已更新' });
            } catch (error) {
              showToast({ type: 'error', message: error instanceof Error ? error.message : '操作失败' });
            }
          }}
        />
      )}
      {editingItem && (
        <ItemFormDialog
          title={editingItem === 'new' ? '添加物品' : '编辑物品'}
          item={editingItem === 'new' ? undefined : editingItem}
          onCancel={() => setEditingItem(undefined)}
          onSubmit={async (input) => {
            try {
              if (editingItem === 'new') {
                await createItem({ ...input, boxId: box.id });
                showToast({ type: 'success', message: '物品已添加' });
              } else {
                await updateItem(editingItem, input);
                showToast({ type: 'success', message: '物品已更新' });
              }
              await reload();
              setEditingItem(undefined);
            } catch (error) {
              showToast({ type: 'error', message: error instanceof Error ? error.message : '操作失败' });
            }
          }}
          onContinue={async (input) => {
            try {
              await createItem({ ...input, boxId: box.id });
              await loadBoxData();
              showToast({ type: 'success', message: '已添加，继续填写下一个' });
            } catch (error) {
              showToast({ type: 'error', message: error instanceof Error ? error.message : '操作失败' });
            }
          }}
        />
      )}
      {stockAction && (
        <StockDialog
          item={stockAction.item}
          type={stockAction.type}
          totalInbound={cumulativeInbound(stockAction.item.id, movements)}
          onCancel={() => setStockAction(undefined)}
          onSubmit={async (quantity, input) => {
            try {
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
            } catch (error) {
              showToast({ type: 'error', message: error instanceof Error ? error.message : '操作失败' });
            }
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
      const ownBox = getSession() ? await getBox(shared.boxId) : undefined;
      controlsRef.current?.stop();
      if (ownBox) {
        navigate({ name: 'box', id: shared.boxId });
      } else {
        navigate({ name: 'shared', id: shared.boxId, token: shared.token });
      }
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
        const controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
          if (result && !stopped) {
            stopped = true;
            openCode(result.getText()).catch((error) => showToast({ type: 'error', message: error.message }));
          }
        });
        controlsRef.current = controls;
        if (stopped) {
          controls.stop();
          return;
        }
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
  appVersion,
  tab,
  onTab,
}: {
  boxes: Box[];
  items: Item[];
  movements: StockMovement[];
  showToast: (toast: Toast) => void;
  refresh: () => Promise<void>;
  session: AuthSession;
  online: boolean;
  syncStatus: { queued: number; conflicts: number };
  appVersion: string;
  tab: ToolsTab;
  onTab: (tab: ToolsTab) => void;
}) {
  const mode = tab;
  const setMode = onTab;
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
      } else {
        await api.post('/audit', { action: 'export.boxes', detail: `导出 ${selected.size} 个箱子的明细表` }).catch(() => undefined);
        if (result.method === 'download') {
          showToast({ type: 'success', message: 'Excel 已生成，请查看浏览器下载记录' });
        } else {
          showToast({ type: 'success', message: 'Excel 已生成，可在系统弹窗中保存或分享' });
        }
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
      {appVersion && appVersion !== 'builtin' && (
        <p className="app-version-label">老于智慧仓管 v{appVersion}</p>
      )}
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
        className="profile-form"
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
            const next = await api.post<AuthSession>('/auth/profile/update', {
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
        <div className="section-title"><div><h2>账号信息</h2><p>修改时需要验证当前密码</p></div></div>
        <label className="field"><span>账号</span><input value={username} onChange={(event) => setUsername(event.target.value.trim())} /></label>
        <label className="field"><span>当前密码</span><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
        <label className="field"><span>新密码</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="不修改可留空" /></label>
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
  const [boxIds, setBoxIds] = useState<Set<string>>(new Set());
  const [teamNames, setTeamNames] = useState<Set<string>>(new Set());
  const [editingMovement, setEditingMovement] = useState<StockMovement>();
  const teams = useMemo(
    () => Array.from(new Set(movements.map((movement) => movement.teamName).filter(Boolean) as string[])),
    [movements],
  );
  const hasFilter = Boolean(fromDate || toDate || boxIds.size || teamNames.size);
  const filteredMovements = useMemo(() => {
    return movements.filter((movement) => {
      const date = movement.createdAt.slice(0, 10);
      const fromMatched = !fromDate || date >= fromDate;
      const toMatched = !toDate || date <= toDate;
      const boxMatched = boxIds.size === 0 || boxIds.has(movement.boxId);
      const teamMatched = teamNames.size === 0 || teamNames.has(movement.teamName ?? '');
      return fromMatched && toMatched && boxMatched && teamMatched;
    });
  }, [boxIds, fromDate, movements, teamNames, toDate]);
  const toggleInSet = <T,>(setState: React.Dispatch<React.SetStateAction<Set<T>>>, value: T) =>
    setState((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  const filterSummary = {
    fromDate,
    toDate,
    boxName: boxIds.size ? boxes.filter((box) => boxIds.has(box.id)).map((box) => box.name).join('、') : undefined,
    teamName: teamNames.size ? Array.from(teamNames).join('、') : undefined,
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
        await api.post('/audit', { action: 'export.movements', detail: `导出${scope === 'filtered' ? '筛选' : '全部'}流水 ${selectedMovements.length} 条` }).catch(() => undefined);
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
      </div>
      <div className="filter-group">
        <div className="filter-group-head">
          <span>箱子{boxIds.size > 0 ? `（已选 ${boxIds.size}）` : '（不选=全部）'}</span>
          {boxIds.size > 0 && <button onClick={() => setBoxIds(new Set())}>清空</button>}
        </div>
        <div className="filter-chips">
          {boxes.map((box) => (
            <button
              key={box.id}
              className={`filter-chip${boxIds.has(box.id) ? ' active' : ''}`}
              onClick={() => toggleInSet(setBoxIds, box.id)}
            >
              {box.name}
            </button>
          ))}
        </div>
      </div>
      {teams.length > 0 && (
        <div className="filter-group">
          <div className="filter-group-head">
            <span>班组{teamNames.size > 0 ? `（已选 ${teamNames.size}）` : '（不选=全部）'}</span>
            {teamNames.size > 0 && <button onClick={() => setTeamNames(new Set())}>清空</button>}
          </div>
          <div className="filter-chips">
            {teams.map((team) => (
              <button
                key={team}
                className={`filter-chip${teamNames.has(team) ? ' active' : ''}`}
                onClick={() => toggleInSet(setTeamNames, team)}
              >
                {team}
              </button>
            ))}
          </div>
        </div>
      )}
      {hasFilter && (
        <button className="ghost full" onClick={() => {
          setFromDate('');
          setToDate('');
          setBoxIds(new Set());
          setTeamNames(new Set());
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
                    {movement.type !== 'adjust' && (
                      <button className="inline-edit-btn" onClick={() => setEditingMovement(movement)}>
                        编辑
                      </button>
                    )}
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
                  try {
                    await restoreBackup(pendingBackup);
                    await refresh();
                    showToast({ type: 'success', message: '备份已恢复' });
                  } catch (error) {
                    showToast({ type: 'error', message: error instanceof Error ? error.message : '恢复失败' });
                  } finally {
                    setPendingBackup(undefined);
                  }
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

function Fab({ onClick }: { onClick: () => void }) {
  return (
    <button className="fab" onClick={onClick} aria-label="添加">
      <Plus size={26} />
    </button>
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
          try {
            await onSubmit({ name, note, imageDataUrl });
          } finally {
            setSaving(false);
          }
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
  onContinue,
}: {
  title: string;
  item?: Item;
  onCancel: () => void;
  onSubmit: (input: {
    name: string;
    specModel?: string;
    quantity: number;
    unit?: string;
    imageDataUrl?: string;
    note?: string;
    createdAt?: string;
  }) => Promise<void>;
  onContinue?: (input: {
    name: string;
    specModel?: string;
    quantity: number;
    unit?: string;
    imageDataUrl?: string;
    note?: string;
    createdAt?: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [specModel, setSpecModel] = useState(item?.specModel ?? '');
  const [quantity, setQuantity] = useState(item ? String(item.quantity) : '');
  const [unit, setUnit] = useState(item?.unit ?? '');
  const [imageDataUrl, setImageDataUrl] = useState(item?.imageDataUrl ?? '');
  const [note, setNote] = useState(item?.note ?? '');
  const [createdAt, setCreatedAt] = useState(toDatetimeLocal(item?.createdAt));
  const [saving, setSaving] = useState(false);
  const numericQuantity = quantity.trim() === '' ? Number.NaN : Number(quantity);

  const buildInput = () => ({
    name,
    specModel,
    quantity: numericQuantity,
    unit,
    imageDataUrl,
    note,
    createdAt: item ? undefined : fromDatetimeLocal(createdAt),
  });

  const isValid = name.trim() && Number.isFinite(numericQuantity) && numericQuantity >= 0;

  const handleContinue = async () => {
    if (!isValid || !onContinue) return;
    setSaving(true);
    try {
      await onContinue(buildInput());
      setSpecModel('');
      setQuantity('');
      setNote('');
      setImageDataUrl('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={title} onCancel={onCancel}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!isValid) return;
          setSaving(true);
          try {
            await onSubmit(buildInput());
          } finally {
            setSaving(false);
          }
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
        <div className="field-grid two">
          <label className="field">
            {item ? '当前数量' : '入库数量'}
            <input inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          </label>
          <label className="field">
            单位
            <input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="个" />
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
        <div className={`dialog-actions${!item && onContinue ? ' three-cols' : ''}`}>
          <button type="button" className="ghost" onClick={onCancel}>
            取消
          </button>
          {!item && onContinue && (
            <button type="button" className="ghost" disabled={!isValid || saving} onClick={handleContinue}>
              继续添加
            </button>
          )}
          <button className="primary" disabled={!isValid || saving}>
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
  totalInbound,
  onCancel,
  onSubmit,
}: {
  item: Item;
  type: 'in' | 'out';
  totalInbound: number;
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
    try {
      if (type === 'out' && teamName.trim()) {
        const next = [teamName.trim(), ...teamSuggestions.filter((entry) => entry !== teamName.trim())].slice(0, 6);
        localStorage.setItem('teamSuggestions', JSON.stringify(next));
        setTeamSuggestions(next);
      }
      await onSubmit(value, { note, teamName, imageDataUrl, createdAt: fromDatetimeLocal(createdAt) });
    } finally {
      setSaving(false);
    }
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
          <span>累计入库：{totalInbound + (type === 'in' && Number.isFinite(value) && value > 0 ? value : 0)}</span>
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
  const [saveLabel, setSaveLabel] = useState('');
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);
  const panRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const lastTapRef = useRef(0);
  const didDragRef = useRef(false);

  if (!imageDataUrl) {
    return <span className={className} aria-hidden="true">{fallback}</span>;
  }

  const resetZoom = () => { setScale(1); setPos({ x: 0, y: 0 }); };
  const closeLightbox = () => { setPreviewing(false); resetZoom(); };

  const handleSave = async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      if (isNativeApp()) {
        await saveDataUrlPhotoToGallery({ dataUrl: imageDataUrl, fileName: `${alt}.jpg` });
      } else {
        const a = document.createElement('a');
        a.href = imageDataUrl;
        a.download = `${alt}.jpg`;
        a.click();
      }
      setSaveLabel('已保存');
    } catch {
      setSaveLabel('保存失败');
    }
    setTimeout(() => setSaveLabel(''), 2000);
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchRef.current = { dist: Math.hypot(dx, dy), scale };
      panRef.current = null;
    } else if (e.touches.length === 1) {
      panRef.current = { sx: e.touches[0].clientX, sy: e.touches[0].clientY, px: pos.x, py: pos.y };
      didDragRef.current = false;
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 2 && pinchRef.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const next = Math.min(5, Math.max(1, pinchRef.current.scale * (Math.hypot(dx, dy) / pinchRef.current.dist)));
      setScale(next);
      if (next <= 1) setPos({ x: 0, y: 0 });
    } else if (e.touches.length === 1 && panRef.current && scale > 1) {
      const dx = e.touches[0].clientX - panRef.current.sx;
      const dy = e.touches[0].clientY - panRef.current.sy;
      didDragRef.current = true;
      setPos({ x: panRef.current.px + dx, y: panRef.current.py + dy });
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length === 0 && !didDragRef.current && pinchRef.current === null) {
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        scale > 1 ? resetZoom() : setScale(2.5);
      }
      lastTapRef.current = now;
    }
    pinchRef.current = null;
    panRef.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    const next = Math.min(5, Math.max(1, scale * (1 - e.deltaY * 0.001)));
    setScale(next);
    if (next <= 1) setPos({ x: 0, y: 0 });
  };

  const onImgMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    panRef.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y };
    didDragRef.current = false;
  };

  const onOverlayMouseMove = (e: React.MouseEvent) => {
    if (panRef.current) {
      const dx = e.clientX - panRef.current.sx;
      const dy = e.clientY - panRef.current.sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDragRef.current = true;
      if (scale > 1) setPos({ x: panRef.current.px + dx, y: panRef.current.py + dy });
    }
  };

  const onOverlayMouseUp = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!didDragRef.current && scale === 1) closeLightbox();
    panRef.current = null;
  };

  const onImgDblClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    scale > 1 ? resetZoom() : setScale(2.5);
  };

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
          onMouseMove={onOverlayMouseMove}
          onMouseUp={onOverlayMouseUp}
          onMouseLeave={() => { panRef.current = null; }}
          onWheel={onWheel}
        >
          <button type="button" className="photo-lightbox-close" aria-label="关闭照片" onClick={closeLightbox}>
            ×
          </button>
          <button type="button" className="photo-lightbox-save" aria-label="保存照片" onClick={handleSave}>
            {saveLabel ? <span className="photo-lightbox-save-label">{saveLabel}</span> : <Download size={20} />}
          </button>
          <img
            src={imageDataUrl}
            alt={alt}
            draggable={false}
            style={{
              transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
              transformOrigin: 'center',
              cursor: scale > 1 ? 'grab' : 'default',
              touchAction: 'none',
            }}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onMouseDown={onImgMouseDown}
            onDoubleClick={onImgDblClick}
          />
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
