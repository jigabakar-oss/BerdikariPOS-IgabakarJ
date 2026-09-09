import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { useShiftStore } from '../store/shiftStore';
import { useTransactionStore } from '../store/transactionStore';
import { useAuditLogStore } from '../store/auditLogStore';
import { useCashMovementStore } from '../store/cashMovementStore';
import { useToastStore } from '../store/toastStore';
import { useCloudStatus } from '../hooks/useCloudStatus';
import { formatRupiah, formatDate } from '../utils/format';
import { printTextRaw } from '../utils/printer';
// v4.10 P.4: item non-menu (Item Manual) — bucket "Item Non-Menu" + laba kotor di ringkasan shift
import { CUSTOM_ITEM_BUCKET_NAME } from '../utils/customItem';
import { buildMenuSalesSummary } from '../utils/menuSalesSummary';
// v4.7 TO DO 18.3: expected cash tutup shift dari SEMUA transaksi Selesai tersinkron
import { computeShiftStats, EMPTY_SHIFT_STATS } from '../utils/shiftStats';
import { printShiftSummary } from '../utils/shiftPrint';
import { fetchTransactionsFromCloud, fetchShiftsFromCloud } from '../lib/cloudSync';
import { useState, useMemo, useEffect, useRef } from 'react';
import {
  getQueueLength,
  setQueueChangeListener,
  flushQueue,
  clearQueue,
  hydrateQueue,
  getFailedOpsCount,
  setFailedOpsListener,
  getFailedOps,
  retryFailedOps,
  clearFailedOps,
} from '../lib/offlineQueue';
import Modal from './Modal';
import ConfirmDialog from './ConfirmDialog';
import PrinterStatusBanner from './PrinterStatusBanner';
import {
  LayoutDashboard,
  ShoppingCart,
  ChefHat,
  Clock,
  ClipboardList,
  Package,
  Users,
  Settings,
  LogOut,
  Menu as MenuIcon,
  FileBarChart,
  Warehouse,
  PanelLeftClose,
  PanelLeftOpen,
  Wallet,
  Gift,
  Shield,
  Sun,
  Moon,
  ClipboardCheck,
  Printer,
  AlertTriangle,
  WifiOff,
} from 'lucide-react';

const navItems = {
  Manager: [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/pos', icon: ShoppingCart, label: 'POS' },
    { to: '/kitchen', icon: ChefHat, label: 'Dapur' },
    { to: '/transactions', icon: ClipboardList, label: 'Transaksi' },
    { to: '/catalog', icon: Package, label: 'Katalog' },
    { to: '/inventory', icon: Warehouse, label: 'Inventaris' },
    { to: '/promos', icon: Gift, label: 'Promo' },
    { to: '/reports', icon: FileBarChart, label: 'Laporan' },
    { to: '/customers', icon: Users, label: 'Pelanggan' },
    { to: '/cash-movements', icon: Wallet, label: 'Rekap Kas' },
    { to: '/audit-log', icon: Shield, label: 'Audit Log' },
    { to: '/settings', icon: Settings, label: 'Settings' },
  ],
  Kasir: [
    { to: '/pos', icon: ShoppingCart, label: 'POS' },
    { to: '/transactions', icon: ClipboardList, label: 'Transaksi' },
    { to: '/customers', icon: Users, label: 'Pelanggan' },
    { to: '/cash-movements', icon: Wallet, label: 'Rekap Kas' },
    { to: '/settings', icon: Printer, label: 'Printer' },
  ],
  Acaraki: [{ to: '/kitchen', icon: ChefHat, label: 'Dapur' }],
  'Staf Gudang': [
    { to: '/inventory', icon: Warehouse, label: 'Inventaris' },
  ],
};

export default function Layout() {
  const { currentUser, logout } = useAuthStore();
  const { settings } = useSettingsStore();
  const { activeShift, closeShift } = useShiftStore();
  const { transactions, clearKdsDoneOrders } = useTransactionStore();
  const { addLog } = useAuditLogStore();
  const { addToast } = useToastStore();
  const cloudStatus = useCloudStatus();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [queueLength, setQueueLength] = useState(getQueueLength());
  // 🏷️ v4.9.2: Debounce 2.5s untuk antrean transient agar banner tidak berkedip saat checkout normal
  const [debouncedQueueLength, setDebouncedQueueLength] = useState(getQueueLength());
  // v4.7 TO DO 13.2 (O-3): daftar op yang gagal permanen — jangan di-drop diam-diam
  const [failedCount, setFailedCount] = useState(getFailedOpsCount());
  const [showFailedModal, setShowFailedModal] = useState(false);
  // v4.7 TO DO 13.10 (O-10): konfirmasi aksi destruktif via ConfirmDialog (bukan window.confirm)
  const [confirmState, setConfirmState] = useState<{ title?: string; message: string; confirmText?: string; onConfirm: () => void } | null>(null);
  const failedCountRef = useRef(getFailedOpsCount());
  // v4.7 TO DO 13.8 (O-6): deteksi cold start offline — masih disconnected ~4 detik
  // setelah boot = perangkat baru / offline sejak awal (data cloud belum dimuat).
  const bootedOfflineRef = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      bootedOfflineRef.current = cloudStatus === 'disconnected';
    }, 4000);
    return () => clearTimeout(t);
  }, [cloudStatus]);

  useEffect(() => {
    if (queueLength === 0) {
      setDebouncedQueueLength(0);
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedQueueLength(queueLength);
    }, 2500);
    return () => clearTimeout(timer);
  }, [queueLength]);

  useEffect(() => {
    setQueueChangeListener((count) => {
      setQueueLength(count);
    });
    // v4.7 TO DO 13.2 (O-3): op yang gagal permanen tercatat di audit log (bukan hilang diam-diam)
    setFailedOpsListener((count) => {
      if (count > failedCountRef.current && currentUser) {
        addLog(currentUser.id, currentUser.name, currentUser.role, 'sync_failed', `${count - failedCountRef.current} operasi gagal sinkron permanen`, { failedCount: count });
      }
      failedCountRef.current = count;
      setFailedCount(count);
    });
    // v4.7 TO DO 13.1 (O-1): antrean kini dipersist di IndexedDB — hidrasi async saat
    // boot lalu perbarui badge (getQueueLength() awal = 0 sebelum hidrasi selesai).
    hydrateQueue().then((q) => {
      setQueueLength(q.length);
      failedCountRef.current = getFailedOpsCount();
      setFailedCount(failedCountRef.current);
    });
    return () => {
      setQueueChangeListener(() => {});
      setFailedOpsListener(() => {});
    };
  }, [currentUser, addLog]);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));

  // Close shift modal
  const [showCloseShift, setShowCloseShift] = useState(false);
  const [closingCashInput, setClosingCashInput] = useState('');
  // v4.7 TO DO 18.3: peringatan data belum sinkron saat tutup shift + status muat data tersinkron
  const [unsyncedAtClose, setUnsyncedAtClose] = useState(0);
  const [failedAtClose, setFailedAtClose] = useState(0);
  const [syncingCloseStats, setSyncingCloseStats] = useState(false);
  // Acaraki summary modal
  const [showAcarakiSummary, setShowAcarakiSummary] = useState(false);

  const location = useLocation();

  // T3 fix (AUDIT-OX): early-return dipindah ke SETELAH semua hook (useMemo todayTx,
  // useCashMovementStore, useMemo shiftStats, useMemo acarakiDoneOrders) — sebelumnya
  // pelanggaran Rules of Hooks yang bisa crash ("Rendered fewer hooks") saat currentUser
  // menjadi null di tengah sesi (race logout).

  // v4.7 TO DO 18.3: riwayat cetak ringkasan shift memakai window shift (SEMUA kasir,
  // bukan hanya kasir device ini) — konsisten dengan model 1 shift aktif per outlet.
  const todayTx = useMemo(() => {
    if (!activeShift) return [];
    const windowStart = new Date(activeShift.openedAt).getTime();
    return transactions.filter(
      (t) =>
        t.txStatus === 'Selesai' &&
        !t.splitParentId && // v4.1 TO DO 1.6: sub-bill split tidak dihitung ulang (sudah di transaksi induk)
        new Date(t.date).getTime() >= windowStart
    );
  }, [transactions, activeShift]);

  // Calculate shift stats — v4.7 TO DO 18.3: helper murni computeShiftStats memakai
  // SEMUA transaksi Selesai tersinkron dalam window shift (1 shift per outlet),
  // bukan hanya transaksi lokal device / kasir ini.
  const movements = useCashMovementStore((s) => s.movements);
  const shiftStats = useMemo(() => {
    if (!activeShift) return EMPTY_SHIFT_STATS;
    return computeShiftStats(activeShift, transactions, movements);
  }, [activeShift, transactions, movements]);

  // v4.7 TO DO 18.3: sebelum tutup shift — flush antrean + muat ulang transaksi, shift,
  // dan cash movements dari cloud agar expected cash dihitung dari data TERSINKRON.
  // Kegagalan sync tidak menggagalkan tutup shift (best-effort, pola 6.4).
  const syncCloseStats = async () => {
    setSyncingCloseStats(true);
    try {
      await flushQueue();
      const txs = await fetchTransactionsFromCloud();
      if (txs && txs.length > 0) useTransactionStore.getState().loadFromCloud(txs, true);
      await useShiftStore.getState().loadFromCloud();
      await useCashMovementStore.getState().loadFromCloud(true);
    } catch (e) {
      console.warn('[Shift] Gagal memuat data tersinkron saat tutup shift (dilewati):', e);
    } finally {
      setUnsyncedAtClose(getQueueLength());
      setFailedAtClose(getFailedOpsCount());
      setSyncingCloseStats(false);
    }
  };

  const handleLogout = async () => {
    if (!currentUser) return; // T3 fix: handler berada sebelum guard render utama
    if (activeShift && (currentUser.role === 'Kasir' || currentUser.role === 'Manager')) {
      setShowCloseShift(true);
      setClosingCashInput('');
      // Sinkronkan data terbaru dari cloud di latar belakang — statistik shift
      // (termasuk expected cash) diperbarui otomatis via store subscription.
      void syncCloseStats();
    } else if (currentUser.role === 'Acaraki') {
      setShowAcarakiSummary(true);
    } else {
      logout();
      navigate('/');
    }
  };

  // Manager boleh keluar TANPA menutup shift yang sedang berjalan — shift tetap
  // aktif (lokal & cloud) dan bisa dilanjutkan kasir berikutnya via resumeExistingShift.
  const handleLogoutWithoutClose = () => {
    setShowCloseShift(false);
    if (currentUser) {
      addLog(currentUser.id, currentUser.name, currentUser.role, 'logout', 'Keluar tanpa menutup shift kasir — shift tetap aktif untuk dilanjutkan');
    }
    logout();
    navigate('/');
  };

  // Acaraki done orders for summary
  const acarakiDoneOrders = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return transactions.filter(
      (t) => t.kitchenStatus === 'Done' && t.txStatus === 'Selesai' && new Date(t.date) >= today
    );
  }, [transactions]);

  // T3 fix (AUDIT-OX): guard SETELAH semua hook — hook count konsisten antar render.
  if (!currentUser) return null;
  const items = navItems[currentUser.role] || [];

  const handleAcarakiPrint = async () => {
    const lines = [
      '=== RINGKASAN DAPUR ===',
      `Tanggal: ${new Date().toLocaleDateString('id-ID')}`,
      `Acaraki: ${currentUser.name}`,
      `Total Pesanan Selesai: ${acarakiDoneOrders.length}`,
      '',
      '--- Detail ---',
      ...acarakiDoneOrders.map(
        (o) => `#${o.queueNumber} - ${o.items.map((i) => `${i.name} x${i.quantity}`).join(', ')}`
      ),
      '',
      '========================',
    ];
    // T6 fix (AUDIT-OX): cetak best-effort dengan try/finally — bila printer throw
    // (Bluetooth putus/printer mati), Acaraki TIDAK BOLEH terkunci di modal
    // non-dismissable. Escape path (reset KDS + logout) SELALU dijalankan — pola 6.4.
    try {
      await printTextRaw(lines, settings);
    } catch (e) {
      console.warn('[Acaraki] Gagal mencetak ringkasan dapur (logout tetap jalan):', e);
      addToast('Gagal mencetak ringkasan — logout tetap dilanjutkan.', 'warning');
    } finally {
      // Reset done orders on KDS
      clearKdsDoneOrders();
      setShowAcarakiSummary(false);
      logout();
      navigate('/');
    }
  };

  const handleAcarakiSkip = () => {
    clearKdsDoneOrders();
    setShowAcarakiSummary(false);
    logout();
    navigate('/');
  };

  // v4.5 TO DO 6.4: TIDAK ADA langkah yang boleh menggagalkan tutup shift.
  // Audit log & cetak bersifat best-effort; closeShift + keluar SELALU dijalankan,
  // sehingga kasir tidak bisa terkunci di modal (deadlock kuota/Gambar 4).
  const handleCloseShift = async () => {
    const closingCash = parseInt(closingCashInput) || 0;

    // 1. Audit log — best-effort (kegagalan persist/log tidak boleh menggagalkan tutup shift)
    try {
      if (currentUser) {
        addLog(currentUser.id, currentUser.name, currentUser.role, 'close_shift', `Tutup shift - Kas aktual: ${formatRupiah(closingCash)}, Expected: ${formatRupiah(shiftStats.expectedCash)}`, { closingCash, expectedCash: shiftStats.expectedCash, totalSales: shiftStats.totalSales, totalTx: shiftStats.totalTx });
      }
    } catch (e) {
      console.warn('[Shift] Gagal mencatat audit log saat tutup shift (dilewati):', e);
    }

    // 2. Cetak ringkasan — best-effort (kegagalan printer TIDAK menggagalkan tutup shift)
    if (activeShift) {
      try {
        await printShiftSummary({
          shift: activeShift,
          storeName: settings.storeName,
          transactions,
          movements,
          cashierName: currentUser?.name,
          closingCash,
          isReprint: false,
        }, settings);
      } catch (e) {
        console.warn('[Shift] Gagal mencetak ringkasan (shift tetap ditutup):', e);
      }
    }

    // 2b. H.3 Pilar 1 (v4.9.3) — guard konflik force close: bila shift ini SUDAH ditutup
    // dari perangkat lain (Manager force close), jangan menimpa dengan tutup lokal.
    // Adopsi versi cloud + kasir tetap dilepas. Offline / fetch gagal → lanjut normal.
    let conflictClosed = false;
    if (activeShift?.id) {
      try {
        const cloudShifts = await fetchShiftsFromCloud();
        const cloudVer = cloudShifts?.find((s) => s.id === activeShift.id);
        if (cloudVer && cloudVer.status === 'closed') {
          conflictClosed = true;
          addToast(
            `Shift sudah ditutup dari perangkat lain${cloudVer.closedBy ? ` (oleh ${cloudVer.closedBy})` : ''} — data shift cloud dipakai.`,
            'warning'
          );
          await useShiftStore.getState().loadFromCloud();
        }
      } catch {
        // Offline — tidak bisa verifikasi; lanjut tutup lokal (perilaku lama).
      }
    }

    // 3. Tutup shift — selalu dicoba; BUG-UI-STACKED-MODAL fix: setelah printing selesai
    // (dilewati bila shift sudah ditutup device lain — guard 2b)
    if (!conflictClosed) {
      try {
        closeShift(closingCash, shiftStats.totalSales, shiftStats.totalTx, shiftStats.expectedCash);
      } catch (e) {
        // Bahkan jika store gagal (kuota persist), kasir TETAP bisa keluar — shift bisa ditutup
        // ulang / dikoreksi via data shift yang masih ada di cloud.
        console.error('[Shift] Gagal menutup shift di store (kasir tetap dilepas):', e);
        addToast('Gagal menyimpan penutupan shift — coba tutup shift lagi.', 'error');
      }
    }

    // 4. Escape path — modal non-dismissible tidak boleh mengunci kasir
    setShowCloseShift(false);
    logout();
    navigate('/');
  };

  return (
    <div className="flex h-full">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 bg-white dark:bg-slate-800 border-r border-slate-100 dark:border-slate-700/50 flex flex-col transition-all duration-200 ${
          sidebarCollapsed ? 'w-[68px]' : 'w-64'
        } ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        <div className={`p-4 border-b border-slate-100 dark:border-slate-700/50 flex items-center ${sidebarCollapsed ? 'justify-center' : 'gap-3'}`}>
          {settings.storeLogo ? (
            <img src={settings.storeLogo} alt="Logo" className="w-8 h-8 rounded-lg object-contain flex-shrink-0" />
          ) : (
            <span className="text-xl flex-shrink-0">🏪</span>
          )}
          {!sidebarCollapsed && (
            <div className="min-w-0">
              <h1 className="text-base font-bold text-brand-700 dark:text-brand-400 truncate">{settings.storeName}</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">POS System</p>
            </div>
          )}
        </div>

        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setSidebarOpen(false)}
              title={sidebarCollapsed ? item.label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition ${
                  sidebarCollapsed ? 'justify-center' : ''
                } ${
                  isActive
                    ? 'bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50'
                }`
              }
            >
              <item.icon size={18} className="flex-shrink-0" />
              {!sidebarCollapsed && <span>{item.label}</span>}
            </NavLink>
          ))}

        </nav>

        {/* Shift indicator */}
        {activeShift && !sidebarCollapsed && (
          <div className="mx-3 mb-2 p-2.5 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900/50 rounded-xl">
            <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
              <Wallet size={14} />
              <span className="text-xs font-medium">Shift Aktif</span>
            </div>
            <p className="text-xs text-green-600 dark:text-green-500 mt-1">
              Modal: {formatRupiah(activeShift.openingCash)}
            </p>
          </div>
        )}

        {/* Cloud sync status */}
        {!sidebarCollapsed && cloudStatus !== 'disabled' && (
          <button
            onClick={async () => {
              // v4.7 TO DO 13.2 (O-3): op yang gagal permanen dilihat & dikelola di modal
              if (failedCount > 0) {
                setShowFailedModal(true);
                return;
              }
              if (queueLength > 0) {
                const res = await flushQueue();
                if (res.success > 0 && res.failed === 0 && res.pending === 0) {
                  addToast(`Berhasil mengirim ${res.success} data ke Cloud! 🎉`, 'success');
                } else if (res.success > 0) {
                  addToast(`Berhasil sync ${res.success} data, tersisa ${res.pending} data tertunda.`, 'info');
                } else if (res.failed > 0) {
                  setShowFailedModal(true);
                  addToast(`${res.failed} operasi gagal permanen — lihat daftar`, 'warning');
                } else if (res.pending > 0) {
                  addToast(`Masih offline / jaringan belum stabil — ${res.pending} data tertunda akan dicoba otomatis.`, 'warning');
                }
              }
            }}
            className={`w-[calc(100%-1.5rem)] mx-3 mb-2 px-3 py-1.5 rounded-lg flex items-center justify-between text-xs transition ${
              cloudStatus === 'connected' ? 'bg-blue-50 dark:bg-blue-950/20 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30' :
              cloudStatus === 'disconnected' ? 'bg-red-50 dark:bg-red-950/20 text-red-600 dark:text-red-400' :
              'bg-slate-50 dark:bg-slate-900 text-slate-400 dark:text-slate-500'
            }`}
            title={queueLength > 0 ? `${queueLength} operasi sync tertunda. Klik untuk coba sinkronisasi manual ke Supabase.` : 'Cloud Sync Aktif'}
          >
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${
                cloudStatus === 'connected' ? 'bg-blue-500' :
                cloudStatus === 'disconnected' ? 'bg-red-500' :
                'bg-slate-300 animate-pulse'
              }`} />
              <span>{cloudStatus === 'connected' ? 'Cloud Sync' : cloudStatus === 'disconnected' ? 'Offline' : 'Connecting...'}</span>
            </div>
            {failedCount > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-red-500 text-white rounded-full" title={`${failedCount} operasi gagal permanen — klik untuk lihat`}>
                {failedCount}!
              </span>
            )}
            {queueLength > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-amber-500 text-white rounded-full animate-pulse">
                {queueLength}
              </span>
            )}
          </button>
        )}

        {/* Collapse & Theme toggles */}
        <div className={`hidden lg:flex items-center border-t border-slate-100 dark:border-slate-700/50 p-2 ${sidebarCollapsed ? 'flex-col gap-2' : 'justify-between px-4'}`}>
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 transition"
            title={sidebarCollapsed ? 'Perluas sidebar' : 'Sembunyikan sidebar'}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 transition"
            title={theme === 'light' ? 'Mode Gelap' : 'Mode Terang'}
          >
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
        </div>

        {/* User info */}
        <div className={`p-3 border-t border-slate-100 dark:border-slate-700/50 ${sidebarCollapsed ? 'flex flex-col items-center' : ''}`}>
          {!sidebarCollapsed && (
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-full bg-brand-200 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 flex items-center justify-center font-bold text-sm flex-shrink-0">
                {currentUser.name.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium dark:text-slate-200 truncate">{currentUser.name}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{currentUser.role}</p>
              </div>
            </div>
          )}
          <button
            onClick={handleLogout}
            title={sidebarCollapsed ? 'Tutup Shift & Keluar' : undefined}
            className={`btn-ghost text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 ${sidebarCollapsed ? 'p-2' : 'w-full'}`}
          >
            <LogOut size={16} />
            {!sidebarCollapsed && <span>{activeShift ? 'Tutup Shift' : 'Keluar'}</span>}
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0 h-full">
        {/* Printer Status Banner — monitors Bluetooth connections */}
        <PrinterStatusBanner />

        {/* v4.7 TO DO 13.4 (O-4) & v4.9.2: banner global offline / belum sync — TERLIHAT di semua
            device & role (tidak bergantung sidebar yang bisa collapsed di mobile) */}
        {(cloudStatus === 'disconnected' || failedCount > 0 || debouncedQueueLength > 0) && (
          <button
            onClick={async () => {
              if (failedCount > 0) {
                setShowFailedModal(true);
                return;
              }
              if (queueLength > 0) {
                const res = await flushQueue();
                if (res.success > 0 && res.pending === 0) {
                  addToast(`Berhasil mengirim ${res.success} data ke Cloud! 🎉`, 'success');
                } else if (res.pending > 0) {
                  addToast('Masih offline / jaringan belum stabil — akan dicoba otomatis', 'warning');
                }
              }
            }}
            className={`w-full flex items-center justify-center gap-2 px-3 py-1.5 text-xs font-semibold ${
              failedCount > 0
                ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-b border-red-200 dark:border-red-900/40'
                : cloudStatus === 'disconnected'
                ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-b border-red-200 dark:border-red-900/40'
                : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-b border-amber-200 dark:border-amber-900/40'
            }`}
          >
            {failedCount > 0 ? (
              <>
                <AlertTriangle size={14} /> {failedCount} operasi gagal sinkron — klik untuk lihat
              </>
            ) : cloudStatus === 'disconnected' ? (
              <>
                <WifiOff size={14} />{' '}
                {bootedOfflineRef.current
                  ? 'Offline sejak awal — data cloud belum dimuat (perangkat baru?); transaksi tetap bisa dicatat & akan tersinkron'
                  : 'Offline — data tersimpan lokal, akan tersinkron otomatis'}
              </>
            ) : (
              <>
                <Clock size={14} /> {debouncedQueueLength} data belum tersinkron — klik untuk kirim sekarang
              </>
            )}
          </button>
        )}

        {/* Mobile header (Centered Logo & Store Name) */}
        <header className="lg:hidden relative flex items-center justify-between px-4 py-3 bg-white dark:bg-slate-800 border-b border-slate-100 dark:border-slate-700/50 min-h-[56px]">
          <button onClick={() => setSidebarOpen(true)} className="btn-ghost p-2 z-10">
            <MenuIcon size={20} />
          </button>

          {/* Centered Store Logo & Title */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-12">
            <div className="flex items-center gap-2 max-w-[220px] sm:max-w-none">
              {settings.storeLogo ? (
                <img src={settings.storeLogo} alt="Logo" className="w-7 h-7 rounded-lg object-contain flex-shrink-0" />
              ) : (
                <span className="text-lg flex-shrink-0">🌿</span>
              )}
              <h1 className="text-base sm:text-lg font-bold text-brand-700 dark:text-brand-400 truncate text-center">
                {settings.storeName}
              </h1>
            </div>
          </div>

          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 transition z-10"
            title={theme === 'light' ? 'Mode Gelap' : 'Mode Terang'}
          >
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </div>
      </main>

      {/* v4.7 TO DO 13.2 (O-3): modal daftar operasi yang gagal permanen (bukan di-drop) */}
      <Modal
        open={showFailedModal}
        onClose={() => setShowFailedModal(false)}
        title="⚠️ Operasi Gagal Sinkron (Permanen)"
        maxWidth="max-w-2xl"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {failedCount} operasi gagal setelah beberapa percobaan (biasanya izin database / format data).
            Data ini <b>tidak dihapus</b> — coba lagi setelah diperbaiki, atau hapus bila sengaja.
          </p>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {getFailedOps().map((op) => (
              <div key={op.id} className="p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900/30 rounded-xl">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium text-xs text-red-800 dark:text-red-300">
                    {op.table} • {op.action}
                  </p>
                  <span className="text-[10px] text-red-400">{new Date(op.failedAt).toLocaleString()}</span>
                </div>
                <p className="text-xs text-red-600 dark:text-red-400 mt-1 break-all font-mono">{op.lastError}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
            <button
              onClick={() => setShowFailedModal(false)}
              className="btn-secondary flex-1"
            >
              Tutup
            </button>
            <button
              onClick={async () => {
                // Non-destruktif — tidak perlu konfirmasi berat; langsung dipindah ke antrean.
                const revived = await retryFailedOps();
                if (currentUser) {
                  addLog(currentUser.id, currentUser.name, currentUser.role, 'sync_retry', `Coba ulang ${revived} operasi sync yang gagal`);
                }
                if (revived > 0) {
                  addToast(`${revived} operasi dipindah ke antrean & dicoba ulang`, 'info');
                  void flushQueue();
                } else {
                  addToast('Tidak ada operasi gagal untuk dicoba ulang', 'info');
                }
                setShowFailedModal(false);
              }}
              className="btn-primary flex-1"
            >
              Coba Lagi Semua
            </button>
            <button
              onClick={() => {
                // v4.7 TO DO 13.10 (O-10): konfirmasi jelas via ConfirmDialog (bukan window.confirm)
                setConfirmState({
                  title: 'Hapus Operasi Gagal?',
                  message:
                    'Semua operasi di daftar ini TIDAK akan dikirim lagi ke cloud dan bisa hilang permanen. Pastikan Anda sudah mencatat detailnya (tabel, alasan error, waktu).',
                  confirmText: 'Ya, Hapus',
                  onConfirm: () => {
                    const n = getFailedOpsCount();
                    clearFailedOps();
                    if (currentUser) {
                      addLog(currentUser.id, currentUser.name, currentUser.role, 'sync_failed_cleared', `Hapus ${n} operasi sync gagal dari daftar`);
                    }
                    addToast(`${n} operasi gagal dihapus dari daftar`, 'info');
                    setShowFailedModal(false);
                  },
                });
              }}
              className="btn-secondary flex-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
            >
              Hapus Semua
            </button>
          </div>
        </div>
      </Modal>

      {/* v4.7 TO DO 13.10 (O-10): konfirmasi destruktif (hapus failed ops) */}
      <ConfirmDialog
        open={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={() => {
          confirmState?.onConfirm();
          setConfirmState(null);
        }}
        title={confirmState?.title || 'Konfirmasi'}
        message={confirmState?.message || ''}
        confirmText={confirmState?.confirmText || 'Ya, Lanjutkan'}
      />

      {/* Close Shift Modal — Kasir WAJIB isi kas */}
      <Modal
        open={showCloseShift}
        onClose={() => {}} // Cannot dismiss
        title="Tutup Shift & Serah Terima Kas"
        maxWidth="max-w-md"
        dismissible={false}
      >
        <div className="space-y-5">
          {/* v4.7 TO DO 18.3: peringatan bila masih ada data belum sinkron — expected cash
              di bawah belum termasuk transaksi yang belum terkirim (mis. dari perangkat lain) */}
          {(syncingCloseStats || unsyncedAtClose > 0 || failedAtClose > 0) && (
            <div className={`rounded-xl p-3 text-xs border ${
              failedAtClose > 0
                ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/40 text-red-700 dark:text-red-300'
                : unsyncedAtClose > 0
                ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/40 text-amber-800 dark:text-amber-300'
                : 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900/40 text-blue-700 dark:text-blue-300'
            }`}>
              {syncingCloseStats ? (
                <span className="flex items-center gap-2">
                  <span className="animate-pulse">⏳</span> Menyinkronkan data terbaru dari cloud…
                </span>
              ) : (
                <div className="flex items-start justify-between gap-3">
                  <span>
                    ⚠️ <b>{unsyncedAtClose}</b> data belum tersinkron{failedAtClose > 0 && ` + ${failedAtClose} gagal`} — expected cash di bawah bisa belum lengkap (transaksi dari perangkat lain belum terhitung).
                  </span>
                  <button
                    onClick={() => void syncCloseStats()}
                    className="shrink-0 text-[11px] font-semibold underline underline-offset-2 hover:opacity-80"
                  >
                    Kirim & Muat Ulang
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900/50 rounded-xl p-4">
            <h3 className="font-semibold text-sm text-blue-900 dark:text-blue-200 mb-2.5 flex items-center justify-between">
              <span>Ringkasan Shift</span>
              <span className="text-xs font-normal text-blue-600 dark:text-blue-300">Shift Active</span>
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-blue-700 dark:text-blue-300">Modal Awal</span>
                <span className="font-medium text-slate-900 dark:text-slate-100">{formatRupiah(activeShift?.openingCash || 0)}</span>
              </div>

              <div className="flex justify-between">
                <span className="text-blue-700 dark:text-blue-300">Total Penjualan</span>
                <span className="font-medium text-slate-900 dark:text-slate-100">{formatRupiah(shiftStats.totalSales)}</span>
              </div>

              <div className="pl-3 space-y-1 text-xs text-slate-600 dark:text-slate-400 border-l-2 border-blue-200 dark:border-blue-800">
                <div className="flex justify-between">
                  <span>• Penjualan Tunai (Cash)</span>
                  <span>{formatRupiah(shiftStats.cashSales || 0)}</span>
                </div>
                {shiftStats.qrisSales > 0 && (
                  <div className="flex justify-between">
                    <span>• Penjualan QRIS</span>
                    <span>{formatRupiah(shiftStats.qrisSales)}</span>
                  </div>
                )}
                {shiftStats.transferSales > 0 && (
                  <div className="flex justify-between">
                    <span>• Penjualan Transfer</span>
                    <span>{formatRupiah(shiftStats.transferSales)}</span>
                  </div>
                )}
              </div>

              {/* Kas Masuk */}
              <div className="flex justify-between items-center bg-green-50 dark:bg-green-950/30 px-2.5 py-1.5 rounded-lg border border-green-200/50 dark:border-green-900/30">
                <span className="text-green-700 dark:text-green-300 font-medium text-xs">
                  📥 Kas Masuk (Shift Ini)
                </span>
                <span className="font-bold text-green-700 dark:text-green-300">
                  +{formatRupiah(shiftStats.cashIn || 0)}
                </span>
              </div>

              {/* Kas Keluar */}
              <div className="flex justify-between items-center bg-red-50 dark:bg-red-950/30 px-2.5 py-1.5 rounded-lg border border-red-200/50 dark:border-red-900/30">
                <span className="text-red-700 dark:text-red-300 font-medium text-xs">
                  📤 Kas Keluar (Shift Ini)
                </span>
                <span className="font-bold text-red-700 dark:text-red-300">
                  -{formatRupiah(shiftStats.cashOut || 0)}
                </span>
              </div>

              {/* v4.7 TO DO 20.1: penjualan tunai yang di-refund — ditampilkan agar angka
                  totalSales/cashSales (bersih dari refund) tetap bisa dijelaskan ke kasir. */}
              {shiftStats.refundedCashSales > 0 && (
                <div className="flex justify-between items-center bg-orange-50 dark:bg-orange-950/30 px-2.5 py-1.5 rounded-lg border border-orange-200/50 dark:border-orange-900/30">
                  <span className="text-orange-700 dark:text-orange-300 font-medium text-xs">
                    ↩️ Refund Tunai (Dikembalikan)
                  </span>
                  <span className="font-bold text-orange-700 dark:text-orange-300">
                    -{formatRupiah(shiftStats.refundedCashSales)}
                  </span>
                </div>
              )}

              <div className="flex justify-between">
                <span className="text-blue-700 dark:text-blue-300">Jumlah Transaksi</span>
                <span className="font-medium text-slate-900 dark:text-slate-100">{shiftStats.totalTx}</span>
              </div>

              <div className="flex justify-between items-start border-t border-blue-200 dark:border-blue-800 pt-2.5 mt-2">
                <div>
                  <span className="text-blue-900 dark:text-blue-200 font-bold block">Expected Cash di Laci</span>
                  <span className="text-[10px] text-blue-600 dark:text-blue-400 block font-normal">(Modal Awal + Tunai + Kas Masuk - Kas Keluar)</span>
                </div>
                <span className="font-bold text-blue-900 dark:text-blue-200 text-base">{formatRupiah(shiftStats.expectedCash)}</span>
              </div>
            </div>
          </div>

          <div>
            <label className="label">Jumlah Kas Aktual di Laci (Rp) *</label>
            <input
              type="text"
              value={closingCashInput}
              onChange={(e) => setClosingCashInput(e.target.value.replace(/\D/g, ''))}
              placeholder="WAJIB diisi — hitung uang di laci"
              className="input text-lg font-semibold"
              autoFocus
            />
            {closingCashInput && (
              <div className={`mt-2 p-2 rounded-lg text-sm font-medium ${
                parseInt(closingCashInput) === shiftStats.expectedCash
                  ? 'bg-green-50 text-green-700'
                  : parseInt(closingCashInput) > shiftStats.expectedCash
                  ? 'bg-blue-50 text-blue-700'
                  : 'bg-red-50 text-red-700'
              }`}>
                Selisih: {formatRupiah((parseInt(closingCashInput) || 0) - shiftStats.expectedCash)}
                {parseInt(closingCashInput) === shiftStats.expectedCash && ' ✓ Pas'}
              </div>
            )}
            {!closingCashInput && (
              <p className="text-xs text-red-500 mt-1">* Wajib diisi untuk menutup shift</p>
            )}
          </div>

          <button
            onClick={() => {
              const closingCash = parseInt(closingCashInput) || 0;
              const diff = Math.abs(closingCash - shiftStats.expectedCash);
              const threshold = shiftStats.expectedCash * 0.1; // 10%
              // BUG-08: Confirm if difference > 10% of expected — v4.7 TO DO 20.3: window.confirm → ConfirmDialog
              if (diff > threshold && shiftStats.expectedCash > 0) {
                setConfirmState({
                  title: 'Selisih Kas Besar',
                  message: `Selisih kas ${formatRupiah(diff)} (${diff > 0 ? 'lebih' : 'kurang'}) dari expected cash. Apakah Anda yakin jumlah kas sudah benar?`,
                  confirmText: 'Ya, Tutup Shift',
                  onConfirm: () => handleCloseShift(),
                });
                return;
              }
              handleCloseShift();
            }}
            className="btn-primary w-full"
            disabled={!closingCashInput}
          >
            Print Ringkasan & Tutup Shift
          </button>

          {/* Manager boleh keluar tanpa menutup shift — shift tetap aktif & bisa
              dilanjutkan kasir berikutnya (resumeExistingShift). */}
          {currentUser.role === 'Manager' && (
            <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={handleLogoutWithoutClose}
                className="btn-secondary w-full"
              >
                Keluar Tanpa Menutup Shift
              </button>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 text-center mt-2">
                Shift tetap aktif — kasir lain dapat melanjutkan shift ini saat login.
              </p>
            </div>
          )}
        </div>
      </Modal>

      {/* Acaraki Summary Modal */}
      <Modal
        open={showAcarakiSummary}
        onClose={() => {}}
        title="Ringkasan Pesanan Selesai"
        maxWidth="max-w-md"
        dismissible={false}
      >
        <div className="space-y-4">
          <div className="bg-green-50 rounded-xl p-4 text-center">
            <p className="text-sm text-green-700">Total Pesanan Selesai Hari Ini</p>
            <p className="text-3xl font-bold text-green-800">{acarakiDoneOrders.length}</p>
          </div>

          {acarakiDoneOrders.length > 0 && (
            <div className="max-h-48 overflow-y-auto space-y-2">
              {acarakiDoneOrders.map((o) => (
                <div key={o.id} className="flex items-center gap-3 p-2 bg-slate-50 rounded-lg text-sm">
                  <span className="font-bold text-brand-700">#{o.queueNumber}</span>
                  <span className="flex-1 truncate text-slate-600">
                    {o.items.map((i) => `${i.name} x${i.quantity}`).join(', ')}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-3 pt-3 border-t border-slate-100">
            <button onClick={handleAcarakiSkip} className="btn-secondary flex-1 text-sm">
              Lewati
            </button>
            <button onClick={handleAcarakiPrint} className="btn-primary flex-1">
              Print & Keluar
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
