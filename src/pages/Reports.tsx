import { useState, useMemo, useEffect } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useTransactionStore } from '../store/transactionStore';
import { useInventoryStore } from '../store/inventoryStore';
import { useAuthStore } from '../store/authStore';
import { useMenuStore } from '../store/menuStore';
import { useShiftStore } from '../store/shiftStore';
import { useSettingsStore } from '../store/settingsStore';
import { usePromoStore } from '../store/promoStore';
import { formatRupiah, formatDate, buildCustomDateRange } from '../utils/format';
import { buildCategorySales } from '../utils/categorySales';
import { useStockOpnameStore } from '../store/stockOpnameStore';
import { useCashMovementStore } from '../store/cashMovementStore';
// v4.7 TO DO 18.6: indikator "laporan belum final" saat ada data belum tersinkron (reuse badge O-5)
import SyncFreshnessBanner from '../components/SyncFreshnessBanner';
// H.3 Pilar 1 (v4.9.3): Manager Force Close Shift — modal + otorisasi dual-control
import Modal from '../components/Modal';
import PinModal from '../components/PinModal';
import { useToastStore } from '../store/toastStore';
import { useAuditLogStore } from '../store/auditLogStore';
import { computeShiftStats } from '../utils/shiftStats';
import { printShiftSummary } from '../utils/shiftPrint';
import type { CashierShift } from '../types';
import { exportPnlPDF, exportTransactionsPDF, exportInventoryPDF, exportShiftPDF, exportCashPDF, exportPpnPDF } from '../utils/pdfExport';
// v4.7 TO DO 11.2 (P0.1): Laporan PPN bulanan — logika murni
import { isTaxableTransaction, toPpnRow, summarizePpn, aggregatePpnByDay } from '../utils/ppnReport';
// v4.7 TO DO 12.2.4 (P-A3): Laporan performa promo — logika murni
import { aggregatePromoPerformance, toPromoDetailRow } from '../utils/promoReport';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
} from 'chart.js';
import { Doughnut } from 'react-chartjs-2';
import {
  TrendingUp,
  TrendingDown,
  Package,
  Users,
  Calendar,
  AlertTriangle,
  DollarSign,
  FileText,
  Download,
  Wallet,
  ClipboardCheck,
  Receipt,
  Tag,
  Lock,
  Printer,
} from 'lucide-react';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend, ArcElement);

type ReportTab = 'pnl' | 'transactions' | 'inventory' | 'shift' | 'cash' | 'opname' | 'tax' | 'promo';
type DateFilterType = 'today' | 'week' | 'month' | 'all' | 'custom';

export default function Reports() {
  const [activeTab, setActiveTab] = useState<ReportTab>('pnl');
  const [dateFilterType, setDateFilterType] = useState<DateFilterType>('today');
  const [customDateFrom, setCustomDateFrom] = useState('');
  const [customDateTo, setCustomDateTo] = useState('');
  const [filterMonth, setFilterMonth] = useState('');

  const { transactions } = useTransactionStore();
  const { items: inventory } = useInventoryStore();
  const { users } = useAuthStore();
  const { menus } = useMenuStore();
  const { shifts } = useShiftStore();
  const { settings } = useSettingsStore();
  const { records: opnameRecords } = useStockOpnameStore();
  const { promos } = usePromoStore();

  // Filter transactions by date
  const filteredTx = useMemo(() => {
    const now = new Date();
    return transactions.filter((t) => {
      if (t.txStatus !== 'Selesai') return false;
      // v4.1 TO DO 1.6: Sub-bill hasil split bill (anak) tidak dihitung lagi — omset sudah tercatat
      // di transaksi induk (parent). Tanpa ini, omset & HPP terhitung ganda (double accounting).
      if (t.splitParentId) return false;
      // v4.7 TO DO 11.2 (P0.2): transaksi yang sudah di-refund tidak lagi dihitung sebagai penjualan
      // (pendapatan sudah dikembalikan & tercatat sebagai Kas Keluar 'Refund' di Rekap Kas).
      if (t.refunded) return false;
      const d = new Date(t.date);
      switch (dateFilterType) {
        case 'today':
          return d.toDateString() === now.toDateString();
        case 'week': {
          const weekAgo = new Date(now);
          weekAgo.setDate(weekAgo.getDate() - 7);
          return d >= weekAgo;
        }
        case 'month': {
          if (filterMonth) {
            const [y, m] = filterMonth.split('-').map(Number);
            return d.getFullYear() === y && d.getMonth() === m - 1;
          }
          return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        }
        case 'all':
          return true;
        case 'custom': {
          const { from, to } = buildCustomDateRange(customDateFrom, customDateTo);
          return d >= from && d <= to;
        }
        default:
          return true;
      }
    });
  }, [transactions, dateFilterType, customDateFrom, customDateTo, filterMonth]);

  // Compute date range for reuse in other tabs (opname, etc.)
  const { dateFrom, dateTo } = useMemo(() => {
    const now = new Date();
    switch (dateFilterType) {
      case 'today': {
        const from = new Date(now); from.setHours(0, 0, 0, 0);
        const to = new Date(now); to.setHours(23, 59, 59, 999);
        return { dateFrom: from, dateTo: to };
      }
      case 'week': {
        const from = new Date(now); from.setDate(from.getDate() - 7);
        return { dateFrom: from, dateTo: now };
      }
      case 'month': {
        if (filterMonth) {
          const [y, m] = filterMonth.split('-').map(Number);
          const from = new Date(y, m - 1, 1);
          const to = new Date(y, m, 0, 23, 59, 59, 999);
          return { dateFrom: from, dateTo: to };
        }
        const from = new Date(now.getFullYear(), now.getMonth(), 1);
        const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
        return { dateFrom: from, dateTo: to };
      }
      case 'all': {
        return { dateFrom: new Date(0), dateTo: new Date(2099, 11, 31) };
      }
      case 'custom': {
        const { from, to } = buildCustomDateRange(customDateFrom, customDateTo);
        return { dateFrom: from, dateTo: to };
      }
      default:
        return { dateFrom: new Date(0), dateTo: new Date() };
    }
  }, [dateFilterType, customDateFrom, customDateTo, filterMonth]);

  // Filter stock opname records by date range for P&L shrinkage calculation (BUG-02 fix)
  const filteredOpnameRecords = useMemo(() => {
    return opnameRecords.filter((r) => {
      const d = new Date(r.date);
      return d >= dateFrom && d <= dateTo;
    });
  }, [opnameRecords, dateFrom, dateTo]);

  const totalOpnameLoss = useMemo(() => {
    return filteredOpnameRecords.reduce((acc, r) => acc + (r.totalLossValue || 0), 0);
  }, [filteredOpnameRecords]);

  // P&L calculations (BUG-02 fix: include stock opname shrinkage loss in net profit)
  const totalGrossRevenue = filteredTx.reduce((a, t) => a + t.subtotal, 0);
  const totalRevenue = filteredTx.reduce((a, t) => a + t.totalAmount, 0);
  const totalHPP = filteredTx.reduce((a, t) => a + t.hpp, 0);
  const totalDiscount = filteredTx.reduce((a, t) => a + t.discount, 0);
  const totalTax = filteredTx.reduce((a, t) => a + (t.tax || 0), 0); // GAP-3 fix
  const netRevenue = totalGrossRevenue - totalDiscount;
  const grossProfit = netRevenue - totalHPP;
  const netProfit = grossProfit - totalOpnameLoss;
  const profitMargin = netRevenue > 0 ? (netProfit / netRevenue) * 100 : 0;
  const avgTransaction = filteredTx.length > 0 ? totalRevenue / filteredTx.length : 0;

  // Payment breakdown
  const paymentBreakdown = useMemo(() => {
    const map = { Cash: 0, QRIS: 0, Transfer: 0 };
    filteredTx.forEach((t) => { map[t.paymentMethod] += t.totalAmount; });
    return map;
  }, [filteredTx]);

  // Order Type breakdown (Dine In vs Take Away)
  const orderTypeBreakdown = useMemo(() => {
    const map = { 'Dine In': 0, 'Take Away': 0 };
    filteredTx.forEach((t) => {
      const type = t.orderType || 'Dine In';
      if (type === 'Dine In' || type === 'Take Away') {
        map[type] = (map[type] || 0) + 1;
      }
    });
    return map;
  }, [filteredTx]);

  // Category sales
  // v4.5 TO DO 5.11: sub-bill split equal membawa semua item di tiap bagian → revenue/qty
  // per kategori ter-inflasi N×. Bagi kontribusi dengan totalSplitCount (deteksi isEqualSplitSubBill).
  // v4.10 R-A4: item non-menu (Item Manual) → bucket "Item Non-Menu" (bukan "Lainnya").
  const categorySales = useMemo(() => buildCategorySales(filteredTx, menus), [filteredTx, menus]);

  // v4.7 TO DO 11.2 (P0.1): PPN — transaksi kena pajak (tax > 0), DPP = subtotal − diskon
  const ppnTaxable = useMemo(() => filteredTx.filter(isTaxableTransaction), [filteredTx]);
  const ppnSummary = useMemo(() => summarizePpn(filteredTx), [filteredTx]);
  const ppnDays = useMemo(() => aggregatePpnByDay(filteredTx), [filteredTx]);
  const ppnRows = useMemo(
    () => ppnTaxable.map(toPpnRow).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [ppnTaxable]
  );

  // v4.7 TO DO 12.2.4 (P-A3): performa promo — agregasi per promo + detail transaksi ber-promo
  const promoReport = useMemo(
    () => aggregatePromoPerformance(filteredTx, promos),
    [filteredTx, promos]
  );
  const promoRows = promoReport.rows;
  const promoDetails = promoReport.details;
  const promoSummary = promoReport.summary;

  const { movements } = useCashMovementStore();

  // Real-time subscription: sync cash movements & shifts instantly across devices
  useEffect(() => {
    useCashMovementStore.getState().loadFromCloud(true);
    useShiftStore.getState().loadFromCloud();

    if (!isSupabaseConfigured) return;

    // Subscribe to cash_movements Realtime changes
    const cmChannelName = 'reports-cm-rt-' + Math.random().toString(36).substring(2, 9);
    const cmChannel = supabase
      .channel(cmChannelName)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_movements' }, () => {
        useCashMovementStore.getState().loadFromCloud(true);
      })
      .subscribe();

    // Subscribe to shifts Realtime changes
    const shiftChannelName = 'reports-shifts-rt-' + Math.random().toString(36).substring(2, 9);
    const shiftChannel = supabase
      .channel(shiftChannelName)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shifts' }, () => {
        useShiftStore.getState().loadFromCloud();
      })
      .subscribe();

    return () => {
      try { supabase.removeChannel(cmChannel); } catch (_e) { /* ignore */ }
      try { supabase.removeChannel(shiftChannel); } catch (_e) { /* ignore */ }
    };
  }, [dateFilterType, customDateFrom, customDateTo, filterMonth]);

  // Filter cash movements by date range
  const filteredMovements = useMemo(() => {
    return movements.filter((m) => {
      const d = new Date(m.date);
      return d >= dateFrom && d <= dateTo;
    });
  }, [movements, dateFrom, dateTo]);

  // ============================================================
  // H.3 Pilar 1 (v4.9.3): Manager Force Close Shift
  // ============================================================
  const { currentUser } = useAuthStore();
  const [forceCloseTarget, setForceCloseTarget] = useState<CashierShift | null>(null);
  const [forceCloseCash, setForceCloseCash] = useState('');
  const [showForceClosePin, setShowForceClosePin] = useState(false);

  const forceCloseStats = useMemo(() => {
    if (!forceCloseTarget) return null;
    return computeShiftStats(forceCloseTarget, transactions, movements);
  }, [forceCloseTarget, transactions, movements]);

  const executeForceClose = () => {
    if (!currentUser || !forceCloseTarget) return;
    // Anti-race (audit integrity): bila shift sudah ditutup dari perangkat lain selagi
    // modal terbuka (realtime loadFromCloud memperbarui store), forceCloseShift akan
    // silent no-op — JANGAN mencatat audit log / toast sukses untuk aksi yang tidak jalan.
    const fresh = useShiftStore.getState().shifts.find((s) => s.id === forceCloseTarget.id);
    if (!fresh || fresh.status !== 'open') {
      useToastStore.getState().addToast(
        'Shift sudah ditutup dari perangkat lain — tutup paksa dibatalkan.',
        'warning'
      );
      setShowForceClosePin(false);
      setForceCloseTarget(null);
      setForceCloseCash('');
      return;
    }
    const closingCash = parseInt(forceCloseCash.replace(/\D/g, '')) || 0;
    useShiftStore.getState().forceCloseShift(forceCloseTarget.id, closingCash, {
      id: currentUser.id,
      name: currentUser.name,
      role: currentUser.role,
    });
    useAuditLogStore.getState().addLog(
      currentUser.id,
      currentUser.name,
      currentUser.role,
      'force_close_shift',
      `Tutup paksa shift ${forceCloseTarget.userName} (dibuka ${new Date(forceCloseTarget.openedAt).toLocaleString('id-ID')}) — kas fisik ${formatRupiah(closingCash)}`,
      {
        shiftId: forceCloseTarget.id,
        openedBy: forceCloseTarget.userName,
        closingCash,
        expectedCash: forceCloseStats?.expectedCash ?? 0,
        totalSales: forceCloseStats?.totalSales ?? 0,
        totalTransactions: forceCloseStats?.totalTx ?? 0,
      }
    );
    useToastStore.getState().addToast(
      `Shift ${forceCloseTarget.userName} ditutup paksa. Selisih kas tercatat di laporan Shift.`,
      'success'
    );
    setShowForceClosePin(false);
    setForceCloseTarget(null);
    setForceCloseCash('');
  };

  // ============================================================
  // Cetak Ulang Ringkasan Rekap Shift (isReprint = true)
  // ============================================================
  const [printingShiftId, setPrintingShiftId] = useState<string | null>(null);

  const handleReprintShift = async (emp: any) => {
    const shiftKey = emp.id || emp.name;
    setPrintingShiftId(shiftKey);
    try {
      const targetShift: CashierShift = shifts.find((s) => s.id === emp.id) ?? {
        id: emp.id || `shift-${Date.now()}`,
        userId: emp.id || 'unknown',
        userName: emp.name,
        openedAt: emp.firstTx,
        closedAt: emp.status === 'closed' ? emp.lastTx : undefined,
        openingCash: emp.openingCash || 0,
        closingCash: emp.closingCash,
        expectedCash: emp.expectedCash,
        cashDifference: emp.cashDiff,
        totalSales: emp.revenue,
        totalTransactions: emp.txCount,
        status: emp.status === 'open' ? 'open' : 'closed',
      };

      useToastStore.getState().addToast(`Mencetak ringkasan shift ${emp.name}...`, 'info');
      await printShiftSummary(
        {
          shift: targetShift,
          storeName: settings.storeName,
          transactions,
          movements,
          cashierName: emp.name,
          closingCash: emp.closingCash,
          isReprint: true,
        },
        settings
      );
    } catch (err) {
      console.error('Gagal mencetak ulang shift:', err);
      useToastStore.getState().addToast('Gagal mencetak ulang ringkasan shift', 'error');
    } finally {
      setPrintingShiftId(null);
    }
  };

  // Filter shifts by date range
  const filteredShifts = useMemo(() => {
    return shifts.filter((s) => {
      const d = new Date(s.openedAt);
      return d >= dateFrom && d <= dateTo;
    });
  }, [shifts, dateFrom, dateTo]);

  // Detailed Shift & Employee Report
  const detailedShiftReport = useMemo(() => {
    if (filteredShifts.length > 0) {
      return filteredShifts.map((sh) => {
        const openedAt = new Date(sh.openedAt);
        const closedAt = sh.closedAt ? new Date(sh.closedAt) : new Date();

        const shiftTxs = filteredTx.filter((t) => {
          const td = new Date(t.date);
          if (sh.status === 'open') {
            return t.cashierId === sh.userId && td >= openedAt;
          }
          return (
            t.cashierId === sh.userId &&
            td >= openedAt &&
            td <= closedAt
          );
        });

        const txCount = shiftTxs.length;
        const revenue = shiftTxs.reduce((a, t) => a + t.totalAmount, 0);
        const cashSales = shiftTxs.filter((t) => t.paymentMethod === 'Cash').reduce((a, t) => a + t.totalAmount, 0);
        const qrisSales = shiftTxs.filter((t) => t.paymentMethod === 'QRIS').reduce((a, t) => a + t.totalAmount, 0);
        const transferSales = shiftTxs.filter((t) => t.paymentMethod === 'Transfer').reduce((a, t) => a + t.totalAmount, 0);
        const totalDiscount = shiftTxs.reduce((a, t) => a + t.discount, 0);
        const totalTax = shiftTxs.reduce((a, t) => a + (t.tax || 0), 0);

        const shiftMovements = movements.filter((m) => {
          if (m.shiftId && sh.id && m.shiftId === sh.id) {
            return true;
          }
          const md = new Date(m.date);
          const isUserMatch = m.cashierId === sh.userId;
          if (!isUserMatch) return false;

          const openedAtMs = openedAt.getTime() - 60000;
          if (sh.status === 'open') {
            return md.getTime() >= openedAtMs;
          }
          const closedAtMs = closedAt.getTime() + 60000;
          return md.getTime() >= openedAtMs && md.getTime() <= closedAtMs;
        });

        const cashIn = shiftMovements.filter((m) => m.type === 'in').reduce((a, m) => a + m.amount, 0);
        const cashOut = shiftMovements.filter((m) => m.type === 'out').reduce((a, m) => a + m.amount, 0);

        const expectedCash = sh.expectedCash || (sh.openingCash + cashSales + cashIn - cashOut);
        const closingCash = sh.closingCash;
        const cashDiff = sh.cashDifference !== undefined ? sh.cashDifference : (closingCash !== undefined ? closingCash - expectedCash : undefined);

        return {
          id: sh.id,
          name: sh.userName,
          status: sh.status,
          firstTx: sh.openedAt,
          lastTx: sh.closedAt || sh.openedAt,
          txCount,
          revenue,
          cashSales,
          qrisSales,
          transferSales,
          totalDiscount,
          totalTax,
          openingCash: sh.openingCash,
          cashIn,
          cashOut,
          expectedCash,
          closingCash,
          cashDiff,
        };
      });
    }

    // Fallback: per cashier from filtered transactions
    const map: Record<string, any> = {};
    filteredTx.forEach((t) => {
      if (!map[t.cashierId]) {
        map[t.cashierId] = {
          id: t.cashierId,
          name: t.cashierName,
          status: 'closed',
          txCount: 0,
          revenue: 0,
          cashSales: 0,
          qrisSales: 0,
          transferSales: 0,
          totalDiscount: 0,
          totalTax: 0,
          firstTx: t.date,
          lastTx: t.date,
          openingCash: 0,
          cashIn: 0,
          cashOut: 0,
          expectedCash: 0,
          closingCash: 0,
          cashDiff: 0,
        };
      }
      map[t.cashierId].txCount++;
      map[t.cashierId].revenue += t.totalAmount;
      map[t.cashierId].totalDiscount += t.discount;
      map[t.cashierId].totalTax += (t.tax || 0);
      if (t.paymentMethod === 'Cash') map[t.cashierId].cashSales += t.totalAmount;
      if (t.paymentMethod === 'QRIS') map[t.cashierId].qrisSales += t.totalAmount;
      if (t.paymentMethod === 'Transfer') map[t.cashierId].transferSales += t.totalAmount;
      if (t.date < map[t.cashierId].firstTx) map[t.cashierId].firstTx = t.date;
      if (t.date > map[t.cashierId].lastTx) map[t.cashierId].lastTx = t.date;
    });

    return Object.values(map).sort((a: any, b: any) => b.revenue - a.revenue);
  }, [filteredShifts, filteredTx, movements]);

  // Inventory
  const totalInventoryValue = inventory.reduce((a, i) => a + i.stock * i.costPerUnit, 0);
  const lowStockItems = inventory.filter((i) => i.stock < (i.minStock ?? 3));

  // Export functions
  const exportPnlExcel = () => {
    const rows = [
      ['LAPORAN LABA RUGI'],
      ['Periode', getDateLabel()],
      [''],
      ['Keterangan', 'Jumlah (Rp)'],
      ['Total Pendapatan (Gross)', totalGrossRevenue],
      ['Diskon yang Diberikan', -totalDiscount],
      ['Pendapatan Bersih (Net)', netRevenue],
      ['Pajak Terkumpul', totalTax],
      ['Harga Pokok Penjualan (HPP)', -totalHPP],
      ['Laba Kotor', grossProfit],
      ['Kerugian Stock Opname (Bahan Basi/Rusak/Hilang)', -totalOpnameLoss],
      ['Laba Bersih Operasional (Net Profit)', netProfit],
      [''],
      ['Jumlah Transaksi', filteredTx.length],
      ['Rata-rata per Transaksi', Math.round(avgTransaction)],
      ['Margin (%)', profitMargin.toFixed(1) + '%'],
      [''],
      ['DISTRIBUSI PEMBAYARAN'],
      ['Cash', paymentBreakdown.Cash],
      ['QRIS', paymentBreakdown.QRIS],
      ['Transfer', paymentBreakdown.Transfer],
      [''],
      ['TIPE PESANAN'],
      ['Dine In', orderTypeBreakdown['Dine In']],
      ['Take Away', orderTypeBreakdown['Take Away']],
      [''],
      ['PENJUALAN PER KATEGORI'],
      ['Kategori', 'Revenue', 'Qty'],
      ...categorySales.map(([cat, data]) => [cat, data.revenue, data.qty]),
    ];
    downloadCSV(rows, 'laporan-laba-rugi.csv');
  };

  const exportInventoryExcel = () => {
    const rows = [
      ['LAPORAN STOK BAHAN BAKU'],
      ['Tanggal Export', new Date().toLocaleDateString('id-ID')],
      [''],
      ['ID', 'Nama', 'Stok', 'Unit', 'Harga/Unit', 'Nilai', 'Min. Stok', 'Status'],
      ...inventory.map((i) => [
        i.id,
        i.name,
        i.stock,
        i.unit,
        i.costPerUnit,
        i.stock * i.costPerUnit,
        i.minStock ?? 3,
        i.stock < (i.minStock ?? 3) ? 'RENDAH' : 'Aman',
      ]),
      [''],
      ['Total Nilai Inventaris', '', '', '', '', totalInventoryValue],
      ['Item Stok Rendah', '', '', '', '', lowStockItems.length],
    ];
    downloadCSV(rows, 'laporan-stok-bahan.csv');
  };

  const exportShiftExcel = () => {
    const rows = [
      ['LAPORAN SHIFT KARYAWAN'],
      ['Periode', getDateLabel()],
      [''],
      ['Nama Kasir', 'Jumlah Tx', 'Total Omset', 'Rata-rata/Tx', 'Tunai (Cash)', 'QRIS', 'Transfer', 'Modal Awal', 'Kas Masuk', 'Kas Keluar', 'Expected Cash', 'Kas Aktual', 'Selisih Kas', 'Total Diskon', 'Total Pajak', 'Mulai', 'Akhir'],
      ...detailedShiftReport.map((emp) => [
        emp.name,
        emp.txCount,
        emp.revenue,
        emp.txCount > 0 ? Math.round(emp.revenue / emp.txCount) : 0,
        emp.cashSales,
        emp.qrisSales,
        emp.transferSales,
        emp.openingCash,
        emp.cashIn,
        emp.cashOut,
        emp.expectedCash,
        emp.closingCash ?? '-',
        emp.cashDiff ?? 'Pas',
        emp.totalDiscount,
        emp.totalTax,
        formatDate(emp.firstTx),
        formatDate(emp.lastTx),
      ]),
    ];
    downloadCSV(rows, 'laporan-shift-karyawan.csv');
  };

  const exportCashExcel = () => {
    const rows = [
      ['LAPORAN KAS KASIR & ARUS KAS'],
      ['Periode', getDateLabel()],
      [''],
      ['1. RIWAYAT SHIFT KASIR'],
      ['Kasir', 'Tanggal Buka', 'Tanggal Tutup', 'Modal Awal', 'Expected Cash', 'Kas Aktual', 'Selisih', 'Total Penjualan', 'Jml Transaksi'],
      ...filteredShifts.map((s) => [
        s.userName,
        formatDate(s.openedAt),
        s.closedAt ? formatDate(s.closedAt) : '-',
        s.openingCash,
        s.expectedCash ?? 0,
        s.closingCash ?? 0,
        s.cashDifference ?? 0,
        s.totalSales,
        s.totalTransactions,
      ]),
      [''],
      ['2. RIWAYAT ARUS KAS (KAS MASUK & KAS KELUAR)'],
      ['Tanggal', 'Kasir', 'Tipe', 'Kategori', 'Nominal', 'Catatan'],
      ...filteredMovements.map((m) => [
        formatDate(m.date),
        m.cashierName,
        m.type === 'in' ? 'Kas Masuk' : 'Kas Keluar',
        m.category,
        m.amount,
        m.notes || '-',
      ]),
    ];
    downloadCSV(rows, 'laporan-kas-kasir.csv');
  };

  const exportPpnExcel = () => {
    const rows = [
      ['LAPORAN PPN (PAJAK PERTAMBAHAN NILAI)'],
      ['Periode', getDateLabel()],
      [''],
      ['RINGKASAN'],
      ['Dasar Pengenaan Pajak (DPP)', ppnSummary.totalDpp],
      ['PPN Terkumpul (Kewajiban Setor)', ppnSummary.totalPpn],
      ['Transaksi Kena Pajak', ppnSummary.taxableCount],
      ['Transaksi Non-Pajak (Exempt)', ppnSummary.exemptCount],
      [''],
      ['REKAP PPN PER HARI'],
      ['Tanggal', 'Jumlah Tx', 'DPP', 'PPN'],
      ...ppnDays.map((d) => [d.label, d.txCount, d.dpp, d.ppn]),
      [''],
      ['DETAIL TRANSAKSI KENA PAJAK'],
      ['No. Antrean', 'Tanggal', 'Kasir', 'DPP', 'PPN', 'Total'],
      ...ppnRows.map((r) => [`#${r.queueNumber}`, formatDate(r.date), r.cashierName, r.dpp, r.ppn, r.total]),
    ];
    downloadCSV(rows, 'laporan-ppn.csv');
  };

  // v4.7 TO DO 12.2.4 (P-A3): export CSV laporan performa promo
  const exportPromoExcel = () => {
    const rows = [
      ['LAPORAN PERFORMA PROMO'],
      ['Periode', getDateLabel()],
      [''],
      ['RINGKASAN'],
      ['Transaksi Memakai Promo', promoSummary.promoUsageCount],
      ['Total Diskon Promo', promoSummary.totalPromoDiscount],
      ['Total Omset Transaksi Promo', promoSummary.totalPromoRevenue],
      ['Diskon Manual/Loyalty (Non-Promo)', promoSummary.manualDiscount],
      [''],
      ['PERFORMA PER PROMO'],
      ['Promo', 'Jumlah Pakai', 'Total Diskon', 'Total Omset', 'Rata-rata Diskon/Tx'],
      ...promoRows.map((r) => [r.promoName, r.usageCount, r.totalDiscount, r.totalRevenue, r.avgDiscount]),
      [''],
      ['DETAIL TRANSAKSI BER-PROMO'],
      ['No. Antrean', 'Tanggal', 'Kasir', 'Pelanggan', 'Promo', 'Diskon Promo', 'Total'],
      ...promoDetails.map((d) => [`#${d.queueNumber}`, formatDate(d.date), d.cashierName, d.customerName || '-', d.promoName, d.promoAmount, d.totalAmount]),
    ];
    downloadCSV(rows, 'laporan-performa-promo.csv');
  };

  const exportTransactionsExcel = () => {
    const rows = [
      ['LAPORAN TRANSAKSI'],
      ['Periode', getDateLabel()],
      [''],
      ['No. Antrean', 'Tanggal', 'Kasir', 'Pelanggan', 'Items', 'Subtotal', 'Diskon', 'Pajak', 'Total', 'Metode', 'Status'],
      ...filteredTx.map((t) => [
        `#${t.queueNumber}`,
        formatDate(t.date),
        t.cashierName,
        t.customerName || '-',
        t.items.map((i) => `${i.name} x${i.quantity}`).join('; '),
        t.subtotal,
        t.discount,
        t.tax || 0,
        t.totalAmount,
        t.paymentMethod,
        t.txStatus,
      ]),
    ];
    downloadCSV(rows, 'laporan-transaksi.csv');
  };

  const downloadCSV = (rows: any[][], filename: string) => {
    const csv = rows.map((row) =>
      row.map((cell) => {
        const str = String(cell ?? '');
        return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(',')
    ).join('\n');
    // Add BOM for Excel compatibility
    const bom = '\uFEFF';
    const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    // D fix (AUDIT-OX): revoke tertunda — revoke instan dapat membatalkan unduhan di
    // sebagian browser; 1 detik cukup untuk memulai unduh lalu bebaskan memori.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const getDateLabel = () => {
    switch (dateFilterType) {
      case 'today': return 'Hari Ini (' + new Date().toLocaleDateString('id-ID') + ')';
      case 'week': return '7 Hari Terakhir';
      case 'month': return filterMonth || 'Bulan Ini';
      case 'all': return 'Semua Tanggal';
      case 'custom': return `${customDateFrom || '...'} s/d ${customDateTo || '...'}`;
      default: return '';
    }
  };

  const tabs = [
    { id: 'pnl' as ReportTab, label: 'Laba Rugi', icon: DollarSign },
    { id: 'transactions' as ReportTab, label: 'Transaksi', icon: FileText },
    { id: 'cash' as ReportTab, label: 'Kas Kasir', icon: Wallet },
    { id: 'tax' as ReportTab, label: 'PPN', icon: Receipt },
    { id: 'promo' as ReportTab, label: 'Promo', icon: Tag },
    { id: 'inventory' as ReportTab, label: 'Stok Bahan', icon: Package },
    { id: 'shift' as ReportTab, label: 'Shift', icon: Users },
    { id: 'opname' as ReportTab, label: 'Stock Opname', icon: ClipboardCheck },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-center sm:text-left w-full sm:w-auto">📊 Laporan</h1>
        <div className="grid grid-cols-2 sm:flex items-center gap-2 w-full sm:w-auto">
          {activeTab === 'pnl' && (
            <button onClick={exportPnlExcel} className="btn-secondary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <Download size={14} /> CSV
            </button>
          )}
          {activeTab === 'pnl' && (
            <button onClick={() => exportPnlPDF({ storeName: settings.storeName, period: getDateLabel(), totalRevenue: totalGrossRevenue, totalHPP, totalDiscount, totalTax, netRevenue, grossProfit, totalOpnameLoss, netProfit, profitMargin, txCount: filteredTx.length, avgTransaction, paymentBreakdown, orderTypeBreakdown, categorySales })} className="btn-primary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <FileText size={14} /> PDF
            </button>
          )}
          {activeTab === 'inventory' && (
            <button onClick={exportInventoryExcel} className="btn-secondary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <Download size={14} /> CSV
            </button>
          )}
          {activeTab === 'inventory' && (
            <button onClick={() => exportInventoryPDF({ storeName: settings.storeName, items: inventory.map((i) => ({ name: i.name, stock: String(i.stock), unit: i.unit, minStock: String(i.minStock ?? 3), cost: formatRupiah(i.costPerUnit), value: formatRupiah(i.stock * i.costPerUnit), status: i.stock < (i.minStock ?? 3) ? 'RENDAH' : 'Aman' })), totalValue: totalInventoryValue, lowStockCount: lowStockItems.length })} className="btn-primary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <FileText size={14} /> PDF
            </button>
          )}
          {activeTab === 'shift' && (
            <button onClick={exportShiftExcel} className="btn-secondary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <Download size={14} /> CSV
            </button>
          )}
          {activeTab === 'shift' && (
            <button onClick={() => exportShiftPDF({ storeName: settings.storeName, period: getDateLabel(), shifts: detailedShiftReport.map((e) => ({ name: e.name, txCount: String(e.txCount), revenue: formatRupiah(e.revenue), avg: formatRupiah(e.txCount > 0 ? e.revenue / e.txCount : 0), from: formatDate(e.firstTx), to: formatDate(e.lastTx), cashSales: formatRupiah(e.cashSales), qrisSales: formatRupiah(e.qrisSales), transferSales: formatRupiah(e.transferSales), cashIn: formatRupiah(e.cashIn), cashOut: formatRupiah(e.cashOut), diff: e.cashDiff !== undefined ? (e.cashDiff === 0 ? 'Pas' : formatRupiah(e.cashDiff)) : '-' })) })} className="btn-primary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <FileText size={14} /> PDF
            </button>
          )}
          {activeTab === 'cash' && (
            <button onClick={exportCashExcel} className="btn-secondary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <Download size={14} /> CSV
            </button>
          )}
          {activeTab === 'cash' && (
            <button onClick={() => exportCashPDF({ storeName: settings.storeName, shifts: filteredShifts.map((s) => ({ cashier: s.userName, open: formatDate(s.openedAt), close: s.closedAt ? formatDate(s.closedAt) : '-', opening: formatRupiah(s.openingCash), expected: formatRupiah(s.expectedCash || 0), actual: formatRupiah(s.closingCash || 0), diff: formatRupiah(s.cashDifference || 0), sales: formatRupiah(s.totalSales), tx: String(s.totalTransactions) })), cashMovements: filteredMovements.map((m) => ({ date: formatDate(m.date), cashier: m.cashierName, type: m.type === 'in' ? 'Kas Masuk' : 'Kas Keluar', category: m.category, amount: formatRupiah(m.amount), notes: m.notes || '-' })) })} className="btn-primary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <FileText size={14} /> PDF
            </button>
          )}
          {activeTab === 'transactions' && (
            <button onClick={exportTransactionsExcel} className="btn-secondary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <Download size={14} /> CSV
            </button>
          )}
          {activeTab === 'transactions' && (
            <button onClick={() => exportTransactionsPDF({ storeName: settings.storeName, period: getDateLabel(), transactions: filteredTx.map((t) => ({ queue: `#${t.queueNumber}`, date: formatDate(t.date), cashier: t.cashierName, customer: t.customerName || '-', items: t.items.map((i) => `${i.name} x${i.quantity}`).join(', '), tax: formatRupiah(t.tax || 0), total: formatRupiah(t.totalAmount), method: t.paymentMethod, status: t.txStatus })), totalRevenue, txCount: filteredTx.length })} className="btn-primary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <FileText size={14} /> PDF
            </button>
          )}
          {activeTab === 'tax' && (
            <button onClick={exportPpnExcel} className="btn-secondary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <Download size={14} /> CSV
            </button>
          )}
          {activeTab === 'tax' && (
            <button onClick={() => exportPpnPDF({
              storeName: settings.storeName,
              period: getDateLabel(),
              summary: ppnSummary,
              days: ppnDays.map((d) => ({ label: d.label, txCount: d.txCount, dpp: formatRupiah(d.dpp), ppn: formatRupiah(d.ppn) })),
              rows: ppnRows.map((r) => ({ queue: `#${r.queueNumber}`, date: formatDate(r.date), dpp: formatRupiah(r.dpp), ppn: formatRupiah(r.ppn), total: formatRupiah(r.total) })),
            })} className="btn-primary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <FileText size={14} /> PDF
            </button>
          )}
          {activeTab === 'promo' && (
            <button onClick={exportPromoExcel} className="btn-secondary text-sm flex items-center justify-center gap-1.5 py-2 px-3 w-full sm:w-auto">
              <Download size={14} /> CSV
            </button>
          )}
        </div>
      </div>

      {/* v4.7 TO DO 18.6: peringatan laporan belum final saat ada transaksi/operasi belum sync */}
      <SyncFreshnessBanner />

      {/* Date Filter */}
      <div className="card p-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          <div className="flex items-center gap-2">
            <Calendar size={16} className="text-slate-400" />
            <span className="text-sm font-medium text-slate-600">Filter:</span>
          </div>
          <div className="flex gap-2 flex-wrap">
            {([
              { value: 'today', label: 'Hari Ini' },
              { value: 'week', label: '7 Hari' },
              { value: 'month', label: 'Bulan' },
              { value: 'all', label: 'Semua' },
              { value: 'custom', label: 'Tanggal' },
            ] as { value: DateFilterType; label: string }[]).map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDateFilterType(opt.value)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                  dateFilterType === opt.value
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Month picker */}
          {dateFilterType === 'month' && (
            <input
              type="month"
              value={filterMonth}
              onChange={(e) => setFilterMonth(e.target.value)}
              className="input w-auto text-sm"
            />
          )}

          {/* Custom date range */}
          {dateFilterType === 'custom' && (
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="date"
                value={customDateFrom}
                onChange={(e) => setCustomDateFrom(e.target.value)}
                className="input w-auto text-sm"
              />
              <span className="text-sm text-slate-400">s/d</span>
              <input
                type="date"
                value={customDateTo}
                onChange={(e) => setCustomDateTo(e.target.value)}
                className="input w-auto text-sm"
              />
            </div>
          )}
        </div>
        <p className="text-xs text-slate-400 mt-2">
          Menampilkan {filteredTx.length} transaksi • {getDateLabel()}
        </p>
      </div>

      {/* Tabs (Responsive scrollable for mobile) */}
      <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl overflow-x-auto whitespace-nowrap scrollbar-none">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-shrink-0 flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg text-sm font-medium transition ${
              activeTab === tab.id
                ? 'bg-white dark:bg-slate-700 shadow-sm text-brand-700 dark:text-brand-400 font-semibold'
                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* P&L Tab */}
      {activeTab === 'pnl' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="card p-5">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-green-100 flex items-center justify-center">
                  <TrendingUp className="text-green-600" size={22} />
                </div>
                <div>
                  <p className="text-xs text-slate-500">Total Pendapatan</p>
                  <p className="text-xl font-bold text-green-700">{formatRupiah(totalRevenue)}</p>
                </div>
              </div>
            </div>
            <div className="card p-5">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-red-100 flex items-center justify-center">
                  <TrendingDown className="text-red-600" size={22} />
                </div>
                <div>
                  <p className="text-xs text-slate-500">HPP (COGS)</p>
                  <p className="text-xl font-bold text-red-700">{formatRupiah(totalHPP)}</p>
                </div>
              </div>
            </div>
            <div className="card p-5">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center">
                  <DollarSign className="text-purple-600" size={22} />
                </div>
                <div>
                  <p className="text-xs text-slate-500">Laba Kotor</p>
                  <p className="text-xl font-bold text-purple-700 dark:text-purple-400">{formatRupiah(grossProfit)}</p>
                </div>
              </div>
            </div>
            <div className="card p-5">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-blue-100 flex items-center justify-center">
                  <FileText className="text-blue-600" size={22} />
                </div>
                <div>
                  <p className="text-xs text-slate-500">Margin</p>
                  <p className="text-xl font-bold text-blue-700">{profitMargin.toFixed(1)}%</p>
                </div>
              </div>
            </div>
          </div>

          {/* Detail P&L */}
          <div className="card p-5">
            <h3 className="font-bold text-lg mb-4">Laporan Laba Rugi</h3>
            <div className="space-y-3">
              <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-700">
                <span className="text-slate-600 dark:text-slate-400">Total Pendapatan Kotor (Revenue Gross)</span>
                <span className="font-bold text-slate-700 dark:text-slate-300">{formatRupiah(totalGrossRevenue)}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-700 pl-4">
                <span className="text-slate-500 dark:text-slate-400">- Diskon yang diberikan</span>
                <span className="text-red-500">({formatRupiah(totalDiscount)})</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-700">
                <span className="text-slate-600 dark:text-slate-400 font-semibold">Pendapatan Bersih (Net Sales)</span>
                <span className="font-bold text-green-700 dark:text-green-400">{formatRupiah(netRevenue)}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-700 pl-4 bg-slate-50/50 dark:bg-slate-800/50 rounded-lg px-2 text-xs">
                <span className="text-slate-500 dark:text-slate-400">ℹ️ PPN / Pajak Terkumpul (Kewajiban Setor)</span>
                <span className="font-medium text-slate-600 dark:text-slate-400">{formatRupiah(totalTax)}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-700 pl-4">
                <span className="text-slate-500 dark:text-slate-400">- Harga Pokok Penjualan (HPP)</span>
                <span className="text-red-500">({formatRupiah(totalHPP)})</span>
              </div>
              <div className="flex justify-between py-3 bg-purple-50 dark:bg-purple-950/30 rounded-xl px-4 font-bold">
                <span>Laba Kotor</span>
                <span className="text-purple-700 dark:text-purple-400">{formatRupiah(grossProfit)}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-700 pl-4">
                <span className="text-slate-500 dark:text-slate-400">- Kerugian Stock Opname (Bahan Basi/Rusak/Hilang)</span>
                <span className="text-amber-600 dark:text-amber-400 font-semibold">({formatRupiah(totalOpnameLoss)})</span>
              </div>
              <div className="flex justify-between py-3 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900/50 rounded-xl px-4 font-bold">
                <span className="text-green-800 dark:text-green-300">Laba Bersih Operasional (Net Profit)</span>
                <span className="text-green-700 dark:text-green-400 text-lg">{formatRupiah(netProfit)}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-700">
                <span className="text-slate-600 dark:text-slate-400">Jumlah Transaksi</span>
                <span className="font-medium">{filteredTx.length}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-100 dark:border-slate-700">
                <span className="text-slate-600 dark:text-slate-400">Rata-rata per Transaksi</span>
                <span className="font-medium">{formatRupiah(avgTransaction)}</span>
              </div>
            </div>
          </div>

          {/* Payment, Order Type & Category */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="card p-5">
              <h3 className="font-bold mb-3">Distribusi Pembayaran</h3>
              <div className="h-48">
                <Doughnut
                  data={{
                    labels: ['Cash', 'QRIS', 'Transfer'],
                    datasets: [{
                      data: [paymentBreakdown.Cash, paymentBreakdown.QRIS, paymentBreakdown.Transfer],
                      backgroundColor: ['#22c55e', '#8b5cf6', '#3b82f6'],
                    }],
                  }}
                  options={{ responsive: true, maintainAspectRatio: false }}
                />
              </div>
              <div className="mt-3 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-green-500" /> Cash</span>
                  <span className="font-medium">{formatRupiah(paymentBreakdown.Cash)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-purple-500" /> QRIS</span>
                  <span className="font-medium">{formatRupiah(paymentBreakdown.QRIS)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-blue-500" /> Transfer</span>
                  <span className="font-medium">{formatRupiah(paymentBreakdown.Transfer)}</span>
                </div>
              </div>
            </div>

            <div className="card p-5">
              <h3 className="font-bold mb-3">Tipe Pesanan</h3>
              <div className="h-48">
                <Doughnut
                  data={{
                    labels: ['Dine In', 'Take Away'],
                    datasets: [{
                      data: [orderTypeBreakdown['Dine In'], orderTypeBreakdown['Take Away']],
                      backgroundColor: ['#06b6d4', '#f97316'],
                    }],
                  }}
                  options={{ responsive: true, maintainAspectRatio: false }}
                />
              </div>
              <div className="mt-3 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-cyan-500" /> Dine In</span>
                  <span className="font-medium">{orderTypeBreakdown['Dine In']} Pesanan</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-orange-500" /> Take Away</span>
                  <span className="font-medium">{orderTypeBreakdown['Take Away']} Pesanan</span>
                </div>
              </div>
            </div>

            <div className="card p-5">
              <h3 className="font-bold mb-3">Penjualan per Kategori</h3>
              <div className="space-y-3 max-h-64 overflow-y-auto">
                {categorySales.map(([cat, data]) => (
                  <div key={cat} className="flex items-center justify-between">
                    <div>
                      <p className="font-medium text-sm">{cat}</p>
                      <p className="text-xs text-slate-400">
                        {Number.isInteger(data.qty) ? data.qty : data.qty.toFixed(1)} item terjual
                      </p>
                    </div>
                    <span className="font-bold text-sm text-brand-700">{formatRupiah(data.revenue)}</span>
                  </div>
                ))}
                {categorySales.length === 0 && (
                  <p className="text-sm text-slate-400 text-center py-4">Belum ada data</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Transactions Tab */}
      {activeTab === 'transactions' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="card p-5">
              <p className="text-xs text-slate-500">Total Transaksi</p>
              <p className="text-2xl font-bold">{filteredTx.length}</p>
            </div>
            <div className="card p-5">
              <p className="text-xs text-slate-500">Total Pendapatan</p>
              <p className="text-2xl font-bold text-green-700">{formatRupiah(totalRevenue)}</p>
            </div>
            <div className="card p-5">
              <p className="text-xs text-slate-500">Rata-rata / Transaksi</p>
              <p className="text-2xl font-bold text-brand-700">{formatRupiah(avgTransaction)}</p>
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="p-4 border-b border-slate-100">
              <h3 className="font-bold">Riwayat Transaksi</h3>
            </div>
            {filteredTx.length === 0 ? (
              <div className="p-8 text-center text-slate-400">
                <p className="text-sm">Belum ada transaksi pada periode ini</p>
              </div>
            ) : (
              <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/80 border-b border-slate-100 dark:border-slate-700 sticky top-0">
                    <tr>
                      <th className="text-left p-3 font-semibold">No.</th>
                      <th className="text-left p-3 font-semibold">Tanggal</th>
                      <th className="text-left p-3 font-semibold">Kasir</th>
                      <th className="text-left p-3 font-semibold">Pelanggan</th>
                      <th className="text-left p-3 font-semibold">Items</th>
                      <th className="text-right p-3 font-semibold">Total</th>
                      <th className="text-center p-3 font-semibold">Metode</th>
                      <th className="text-center p-3 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTx.map((t) => (
                      <tr key={t.id} className="border-b border-slate-50 dark:border-slate-700/40 hover:bg-slate-50 dark:hover:bg-slate-700/30">
                        <td className="p-3 font-bold text-brand-700">#{t.queueNumber}</td>
                        <td className="p-3 text-xs text-slate-500">{formatDate(t.date)}</td>
                        <td className="p-3 text-sm">{t.cashierName}</td>
                        <td className="p-3 text-sm text-slate-500">{t.customerName || '-'}</td>
                        <td className="p-3 text-xs text-slate-600 max-w-[200px] truncate">
                          {t.items.map((i) => `${i.name} x${i.quantity}`).join(', ')}
                        </td>
                        <td className="p-3 text-right font-medium">{formatRupiah(t.totalAmount)}</td>
                        <td className="p-3 text-center">
                          <span className={`badge ${
                            t.paymentMethod === 'Cash' ? 'bg-green-100 text-green-700' :
                            t.paymentMethod === 'QRIS' ? 'bg-purple-100 text-purple-700' :
                            'bg-blue-100 text-blue-700'
                          }`}>
                            {t.paymentMethod}
                          </span>
                        </td>
                        <td className="p-3 text-center">
                          <span className={`badge ${
                            t.txStatus === 'Selesai' ? 'bg-green-100 text-green-700' :
                            t.txStatus === 'Cancel' ? 'bg-red-100 text-red-700' :
                            'bg-purple-100 text-purple-700'
                          }`}>
                            {t.txStatus}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* PPN Tab (v4.7 TO DO 11.2 — P0.1) */}
      {activeTab === 'tax' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="card p-5">
              <p className="text-xs text-slate-500">PPN Terkumpul (Kewajiban Setor)</p>
              <p className="text-2xl font-bold text-brand-700">{formatRupiah(ppnSummary.totalPpn)}</p>
            </div>
            <div className="card p-5">
              <p className="text-xs text-slate-500">Dasar Pengenaan Pajak (DPP)</p>
              <p className="text-2xl font-bold">{formatRupiah(ppnSummary.totalDpp)}</p>
            </div>
            <div className="card p-5">
              <p className="text-xs text-slate-500">Transaksi Kena Pajak</p>
              <p className="text-2xl font-bold text-green-700">{ppnSummary.taxableCount}</p>
            </div>
            <div className="card p-5">
              <p className="text-xs text-slate-500">Transaksi Non-Pajak (Exempt)</p>
              <p className="text-2xl font-bold text-slate-500">{ppnSummary.exemptCount}</p>
            </div>
          </div>

          {/* Rekap per hari */}
          <div className="card overflow-hidden">
            <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between gap-3 flex-wrap">
              <h3 className="font-bold">Rekap PPN per Hari</h3>
              <span className="text-xs text-slate-400">DPP = Subtotal − Diskon (Net Sales)</span>
            </div>
            {ppnDays.length === 0 ? (
              <div className="p-8 text-center text-slate-400">
                <p className="text-sm">Belum ada transaksi kena pajak pada periode ini</p>
              </div>
            ) : (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/80 border-b border-slate-100 dark:border-slate-700 sticky top-0">
                    <tr>
                      <th className="text-left p-3 font-semibold">Tanggal</th>
                      <th className="text-center p-3 font-semibold">Jumlah Tx</th>
                      <th className="text-right p-3 font-semibold">DPP</th>
                      <th className="text-right p-3 font-semibold">PPN</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ppnDays.map((d) => (
                      <tr key={d.dateKey} className="border-b border-slate-50 dark:border-slate-700/40">
                        <td className="p-3 font-medium">{d.label}</td>
                        <td className="p-3 text-center">{d.txCount}</td>
                        <td className="p-3 text-right font-mono">{formatRupiah(d.dpp)}</td>
                        <td className="p-3 text-right font-mono text-brand-700 font-semibold">{formatRupiah(d.ppn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Detail transaksi kena pajak */}
          <div className="card overflow-hidden">
            <div className="p-4 border-b border-slate-100 dark:border-slate-700">
              <h3 className="font-bold">Detail Transaksi Kena Pajak</h3>
            </div>
            {ppnRows.length === 0 ? (
              <div className="p-8 text-center text-slate-400">
                <p className="text-sm">Belum ada data</p>
              </div>
            ) : (
              <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/80 border-b border-slate-100 dark:border-slate-700 sticky top-0">
                    <tr>
                      <th className="text-left p-3 font-semibold">No.</th>
                      <th className="text-left p-3 font-semibold">Tanggal</th>
                      <th className="text-left p-3 font-semibold">Kasir</th>
                      <th className="text-right p-3 font-semibold">DPP</th>
                      <th className="text-right p-3 font-semibold">PPN</th>
                      <th className="text-right p-3 font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ppnRows.map((r) => (
                      <tr key={`${r.queueNumber}-${r.date}`} className="border-b border-slate-50 dark:border-slate-700/40">
                        <td className="p-3 font-bold text-brand-700">#{r.queueNumber}</td>
                        <td className="p-3 text-xs text-slate-500">{formatDate(r.date)}</td>
                        <td className="p-3 text-sm">{r.cashierName}</td>
                        <td className="p-3 text-right font-mono">{formatRupiah(r.dpp)}</td>
                        <td className="p-3 text-right font-mono text-brand-700 font-semibold">{formatRupiah(r.ppn)}</td>
                        <td className="p-3 text-right font-medium">{formatRupiah(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Promo Performance Tab (v4.7 TO DO 12.2.4 — P-A3) */}
      {activeTab === 'promo' && (
        <div className="space-y-6">
          {/* KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="card p-5">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                  <Tag className="text-purple-600 dark:text-purple-400" size={22} />
                </div>
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Transaksi Memakai Promo</p>
                  <p className="text-xl font-bold">{promoSummary.promoUsageCount}</p>
                </div>
              </div>
            </div>
            <div className="card p-5">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                  <TrendingDown className="text-red-600 dark:text-red-400" size={22} />
                </div>
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Total Diskon Promo</p>
                  <p className="text-xl font-bold text-red-600 dark:text-red-400">{formatRupiah(promoSummary.totalPromoDiscount)}</p>
                </div>
              </div>
            </div>
            <div className="card p-5">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                  <TrendingUp className="text-green-600 dark:text-green-400" size={22} />
                </div>
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Omset Transaksi Promo</p>
                  <p className="text-xl font-bold text-green-600 dark:text-green-400">{formatRupiah(promoSummary.totalPromoRevenue)}</p>
                </div>
              </div>
            </div>
            <div className="card p-5">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                  <AlertTriangle className="text-amber-600 dark:text-amber-400" size={22} />
                </div>
                <div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">Diskon Non-Promo (Manual/Loyalty)</p>
                  <p className="text-xl font-bold text-amber-600 dark:text-amber-400">{formatRupiah(promoSummary.manualDiscount)}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Perfoma per promo */}
          <div className="card overflow-hidden">
            <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between gap-3 flex-wrap">
              <h3 className="font-bold">Performa per Promo</h3>
              <span className="text-xs text-slate-400">Diurutkan total diskon tertinggi • data lama tanpa promoAmount = 0</span>
            </div>
            {promoRows.length === 0 ? (
              <div className="p-8 text-center text-slate-400">
                <Tag size={40} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">Belum ada transaksi memakai promo pada periode ini</p>
              </div>
            ) : (
              <div className="overflow-x-auto max-h-96 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/80 border-b border-slate-100 dark:border-slate-700 sticky top-0">
                    <tr>
                      <th className="text-left p-3 font-semibold">Promo</th>
                      <th className="text-center p-3 font-semibold">Jumlah Pakai</th>
                      <th className="text-right p-3 font-semibold">Total Diskon</th>
                      <th className="text-right p-3 font-semibold">Total Omset</th>
                      <th className="text-right p-3 font-semibold">Rata-rata Diskon/Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {promoRows.map((r) => (
                      <tr key={r.promoId} className="border-b border-slate-50 dark:border-slate-700/40 hover:bg-slate-50 dark:hover:bg-slate-700/30">
                        <td className="p-3 font-medium">{r.promoName}</td>
                        <td className="p-3 text-center">
                          <span className="badge bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300">
                            {r.usageCount}×
                          </span>
                        </td>
                        <td className="p-3 text-right font-semibold text-red-600 dark:text-red-400">{formatRupiah(r.totalDiscount)}</td>
                        <td className="p-3 text-right font-medium">{formatRupiah(r.totalRevenue)}</td>
                        <td className="p-3 text-right text-slate-500 dark:text-slate-400">{formatRupiah(r.avgDiscount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Detail transaksi ber-promo */}
          <div className="card overflow-hidden">
            <div className="p-4 border-b border-slate-100 dark:border-slate-700">
              <h3 className="font-bold">Detail Transaksi Ber-Promo</h3>
            </div>
            {promoDetails.length === 0 ? (
              <div className="p-8 text-center text-slate-400">
                <p className="text-sm">Belum ada data</p>
              </div>
            ) : (
              <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/80 border-b border-slate-100 dark:border-slate-700 sticky top-0">
                    <tr>
                      <th className="text-left p-3 font-semibold">No.</th>
                      <th className="text-left p-3 font-semibold">Tanggal</th>
                      <th className="text-left p-3 font-semibold">Kasir</th>
                      <th className="text-left p-3 font-semibold">Pelanggan</th>
                      <th className="text-left p-3 font-semibold">Promo</th>
                      <th className="text-right p-3 font-semibold">Diskon Promo</th>
                      <th className="text-right p-3 font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {promoDetails.map((d) => (
                      <tr key={d.transactionId} className="border-b border-slate-50 dark:border-slate-700/40">
                        <td className="p-3 font-bold text-brand-700">#{d.queueNumber}</td>
                        <td className="p-3 text-xs text-slate-500">{formatDate(d.date)}</td>
                        <td className="p-3 text-sm">{d.cashierName}</td>
                        <td className="p-3 text-sm text-slate-500 dark:text-slate-400">{d.customerName || '-'}</td>
                        <td className="p-3 text-sm font-medium">{d.promoName}</td>
                        <td className="p-3 text-right font-semibold text-red-600 dark:text-red-400">
                          {d.promoAmount > 0 ? `-${formatRupiah(d.promoAmount)}` : formatRupiah(0)}
                        </td>
                        <td className="p-3 text-right font-medium">{formatRupiah(d.totalAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Inventory Tab */}
      {activeTab === 'inventory' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="card p-5">
              <p className="text-xs text-slate-500">Total Item</p>
              <p className="text-2xl font-bold">{inventory.length}</p>
            </div>
            <div className="card p-5">
              <p className="text-xs text-slate-500">Nilai Inventaris</p>
              <p className="text-2xl font-bold text-green-700">{formatRupiah(totalInventoryValue)}</p>
            </div>
            <div className="card p-5">
              <p className="text-xs text-slate-500 flex items-center gap-1">
                <AlertTriangle size={12} className="text-red-500" /> Stok Rendah
              </p>
              <p className="text-2xl font-bold text-red-600">{lowStockItems.length}</p>
            </div>
          </div>

          {lowStockItems.length > 0 && (
            <div className="card p-5">
              <h3 className="font-bold mb-3 flex items-center gap-2 text-red-600">
                <AlertTriangle size={18} /> Peringatan Stok Rendah
              </h3>
              <div className="space-y-2">
                {lowStockItems.map((item) => (
                  <div key={item.id} className="flex items-center justify-between p-3 bg-red-50 dark:bg-red-950/30 rounded-xl border border-red-100 dark:border-red-900/40">
                    <div>
                      <p className="font-medium text-sm">{item.name}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Min. stok: {item.minStock ?? 3} {item.unit}</p>
                    </div>
                    <span className="badge bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300 font-bold">
                      {item.stock} {item.unit}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card overflow-hidden">
            <div className="p-4 border-b border-slate-100 dark:border-slate-700">
              <h3 className="font-bold">Daftar Stok Bahan Baku</h3>
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/80 border-b border-slate-100 dark:border-slate-700 sticky top-0">
                  <tr>
                    <th className="text-left p-3 font-semibold">Nama</th>
                    <th className="text-right p-3 font-semibold">Stok</th>
                    <th className="text-left p-3 font-semibold">Unit</th>
                    <th className="text-right p-3 font-semibold">Min. Stok</th>
                    <th className="text-right p-3 font-semibold">Harga/Unit</th>
                    <th className="text-right p-3 font-semibold">Nilai</th>
                    <th className="text-center p-3 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {inventory.map((item) => {
                    const isLow = item.stock < (item.minStock ?? 3);
                    return (
                      <tr key={item.id} className={`border-b border-slate-50 dark:border-slate-700/40 ${isLow ? 'bg-red-50/50 dark:bg-red-950/20' : ''}`}>
                        <td className="p-3 font-medium">{item.name}</td>
                        <td className="p-3 text-right font-medium">{item.stock}</td>
                        <td className="p-3 text-slate-500 dark:text-slate-400">{item.unit}</td>
                        <td className="p-3 text-right text-slate-500 dark:text-slate-400">{item.minStock ?? 3}</td>
                        <td className="p-3 text-right">{formatRupiah(item.costPerUnit)}</td>
                        <td className="p-3 text-right font-medium">{formatRupiah(item.stock * item.costPerUnit)}</td>
                        <td className="p-3 text-center">
                          {isLow ? (
                            <span className="badge bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">Rendah</span>
                          ) : (
                            <span className="badge bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">Aman</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Shift Tab */}
      {activeTab === 'shift' && (
        <div className="space-y-6">
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-bold text-lg">Laporan Shift Karyawan</h3>
                <p className="text-xs text-slate-500 mt-0.5">Detail rincian omset, metode pembayaran, arus kas, dan penyesuaian laci kas per shift</p>
              </div>
            </div>

            {detailedShiftReport.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">Belum ada data shift / transaksi pada periode ini</p>
            ) : (
              <div className="space-y-4">
                {detailedShiftReport.map((emp, idx) => (
                  <div key={emp.id || idx} className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700/60 space-y-3">
                    {/* Header */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-700 pb-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-brand-200 dark:bg-brand-900/50 flex items-center justify-center text-brand-700 dark:text-brand-300 font-bold">
                          {emp.name.charAt(0)}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-semibold text-sm">{emp.name}</p>
                            <span className={`badge text-[10px] ${emp.status === 'open' ? 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300'}`}>
                              {emp.status === 'open' ? '🟢 Shift Aktif' : '🔒 Tutup Shift'}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5">
                            {formatDate(emp.firstTx)} — {emp.status === 'open' ? 'Sekarang' : formatDate(emp.lastTx)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-end sm:self-center">
                        <button
                          type="button"
                          onClick={() => handleReprintShift(emp)}
                          disabled={printingShiftId === (emp.id || emp.name)}
                          className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 border-brand-200 dark:border-brand-900/50 text-brand-600 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-950/30 whitespace-nowrap"
                          title="Cetak ulang ringkasan rekap shift"
                        >
                          <Printer size={14} /> Cetak Rekap
                        </button>
                        {/* H.3 Pilar 1 (v4.9.3): Manager force close shift gantung */}
                        {emp.status === 'open' && currentUser?.role === 'Manager' && (() => {
                          const targetShift = filteredShifts.find((s) => s.id === emp.id) ?? null;
                          if (!targetShift) return null;
                          return (
                            <button
                              type="button"
                              onClick={() => {
                                setForceCloseTarget(targetShift);
                                setForceCloseCash('');
                              }}
                              className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 whitespace-nowrap"
                              title="Tutup paksa shift yang tertinggal (device kasir rusak / kasir lupa tutup)"
                            >
                              <Lock size={14} /> Tutup Paksa
                            </button>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Primary Metrics */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <div className="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-100 dark:border-slate-700/50">
                        <p className="text-xs text-slate-500">Jumlah Transaksi</p>
                        <p className="text-lg font-bold">{emp.txCount} tx</p>
                      </div>
                      <div className="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-100 dark:border-slate-700/50">
                        <p className="text-xs text-slate-500">Total Omset (Revenue)</p>
                        <p className="text-lg font-bold text-green-600 dark:text-green-400">{formatRupiah(emp.revenue)}</p>
                      </div>
                      <div className="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-100 dark:border-slate-700/50 col-span-2 sm:col-span-1">
                        <p className="text-xs text-slate-500">Rata-rata/Transaksi</p>
                        <p className="text-lg font-bold text-brand-600 dark:text-brand-400">
                          {formatRupiah(emp.txCount > 0 ? emp.revenue / emp.txCount : 0)}
                        </p>
                      </div>
                    </div>

                    {/* Detailed Breakdown Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                      {/* Payment Methods */}
                      <div className="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-100 dark:border-slate-700/50 space-y-1.5">
                        <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center justify-between border-b pb-1 border-slate-100 dark:border-slate-700">
                          <span>💳 Rincian Pembayaran</span>
                        </p>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">💵 Tunai (Cash)</span>
                          <span className="font-semibold">{formatRupiah(emp.cashSales)}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">📱 QRIS</span>
                          <span className="font-semibold text-blue-600 dark:text-blue-400">{formatRupiah(emp.qrisSales)}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">🏦 Transfer Bank</span>
                          <span className="font-semibold text-purple-600 dark:text-purple-400">{formatRupiah(emp.transferSales)}</span>
                        </div>
                      </div>

                      {/* Cash Movements & Drawer */}
                      <div className="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-100 dark:border-slate-700/50 space-y-1.5">
                        <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center justify-between border-b pb-1 border-slate-100 dark:border-slate-700">
                          <span>💼 Rekap Laci Kas</span>
                        </p>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">Modal Awal</span>
                          <span className="font-medium">{formatRupiah(emp.openingCash)}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">📥 Kas Masuk</span>
                          <span className="font-semibold text-green-600">+{formatRupiah(emp.cashIn)}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">📤 Kas Keluar</span>
                          <span className="font-semibold text-red-600">-{formatRupiah(emp.cashOut)}</span>
                        </div>
                        <div className="flex justify-between text-xs pt-1 border-t border-slate-100 dark:border-slate-700">
                          <span className="text-slate-500">Kas Ekspektasi</span>
                          <span className="font-bold">{formatRupiah(emp.expectedCash)}</span>
                        </div>
                        {emp.closingCash !== undefined && (
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">Kas Aktual (Fisik)</span>
                            <span className="font-bold">{formatRupiah(emp.closingCash)}</span>
                          </div>
                        )}
                        {emp.cashDiff !== undefined && (
                          <div className="flex justify-between text-xs font-bold pt-1">
                            <span>Selisih Kas</span>
                            <span className={emp.cashDiff === 0 ? 'text-green-600' : emp.cashDiff > 0 ? 'text-blue-600' : 'text-red-600'}>
                              {emp.cashDiff === 0 ? 'Pas' : formatRupiah(emp.cashDiff)}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Discounts & Taxes */}
                      <div className="p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-100 dark:border-slate-700/50 space-y-1.5">
                        <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center justify-between border-b pb-1 border-slate-100 dark:border-slate-700">
                          <span>🏷️ Diskon & Pajak</span>
                        </p>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">Total Diskon Diberikan</span>
                          <span className="font-semibold text-amber-600">-{formatRupiah(emp.totalDiscount)}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">Total Pajak Terkumpul</span>
                          <span className="font-semibold text-slate-700 dark:text-slate-300">+{formatRupiah(emp.totalTax)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Cash Tab */}
      {activeTab === 'cash' && (() => {
        const totalCashInPeriod = filteredMovements
          .filter((m) => m.type === 'in')
          .reduce((a, m) => a + m.amount, 0);
        const totalCashOutPeriod = filteredMovements
          .filter((m) => m.type === 'out')
          .reduce((a, m) => a + m.amount, 0);
        const netCashPeriod = totalCashInPeriod - totalCashOutPeriod;

        return (
          <div className="space-y-6">
            {/* KPI Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <div className="card p-4">
                <p className="text-xs text-slate-500">Total Shift</p>
                <p className="text-xl font-bold">{filteredShifts.length}</p>
              </div>
              <div className="card p-4">
                <p className="text-xs text-slate-500">Selisih Kas</p>
                <p className={`text-xl font-bold ${
                  filteredShifts.reduce((a, s) => a + (s.cashDifference || 0), 0) >= 0
                    ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                }`}>
                  {formatRupiah(filteredShifts.reduce((a, s) => a + (s.cashDifference || 0), 0))}
                </p>
              </div>
              <div className="card p-4">
                <p className="text-xs text-slate-500">Total Kas Masuk</p>
                <p className="text-xl font-bold text-green-600 dark:text-green-400">
                  +{formatRupiah(totalCashInPeriod)}
                </p>
              </div>
              <div className="card p-4">
                <p className="text-xs text-slate-500">Total Kas Keluar</p>
                <p className="text-xl font-bold text-red-600 dark:text-red-400">
                  -{formatRupiah(totalCashOutPeriod)}
                </p>
              </div>
              <div className="card p-4">
                <p className="text-xs text-slate-500">Arus Kas Bersih (Net)</p>
                <p className={`text-xl font-bold ${netCashPeriod >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-orange-600'}`}>
                  {netCashPeriod >= 0 ? '+' : ''}{formatRupiah(netCashPeriod)}
                </p>
              </div>
            </div>

            {/* Shift History Table */}
            <div className="card overflow-hidden">
              <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
                <h3 className="font-bold text-sm">Riwayat Kasir & Shift</h3>
                <span className="text-xs text-slate-400">{filteredShifts.length} shift</span>
              </div>
              {filteredShifts.length === 0 ? (
                <div className="p-8 text-center text-slate-400">
                  <Wallet size={40} className="mx-auto mb-2 opacity-30" />
                  <p className="text-sm">Belum ada data shift pada periode ini</p>
                </div>
              ) : (
                <div className="overflow-x-auto max-h-80 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800/80 border-b border-slate-100 dark:border-slate-700 sticky top-0 z-10 shadow-sm">
                      <tr>
                        <th className="text-left p-3 font-semibold">Kasir</th>
                        <th className="text-left p-3 font-semibold">Waktu Buka</th>
                        <th className="text-left p-3 font-semibold">Waktu Tutup</th>
                        <th className="text-right p-3 font-semibold">Modal Awal</th>
                        <th className="text-right p-3 font-semibold">Expected</th>
                        <th className="text-right p-3 font-semibold">Aktual</th>
                        <th className="text-right p-3 font-semibold">Selisih</th>
                        <th className="text-right p-3 font-semibold">Penjualan</th>
                        <th className="text-center p-3 font-semibold">Tx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredShifts.map((s) => (
                        <tr key={s.id} className={`border-b border-slate-50 dark:border-slate-700/40 ${
                          s.cashDifference && s.cashDifference < 0 ? 'bg-red-50/50 dark:bg-red-950/20' : ''
                        }`}>
                          <td className="p-3 font-medium">{s.userName}</td>
                          <td className="p-3 text-slate-500 text-xs">{formatDate(s.openedAt)}</td>
                          <td className="p-3 text-slate-500 text-xs">{s.closedAt ? formatDate(s.closedAt) : '-'}</td>
                          <td className="p-3 text-right">{formatRupiah(s.openingCash)}</td>
                          <td className="p-3 text-right">{formatRupiah(s.expectedCash || 0)}</td>
                          <td className="p-3 text-right font-medium">{formatRupiah(s.closingCash || 0)}</td>
                          <td className="p-3 text-right">
                            <span className={`font-bold ${
                              (s.cashDifference || 0) === 0
                                ? 'text-green-600'
                                : (s.cashDifference || 0) > 0
                                ? 'text-blue-600'
                                : 'text-red-600'
                            }`}>
                              {(s.cashDifference || 0) === 0 ? 'Pas' : formatRupiah(s.cashDifference || 0)}
                            </span>
                          </td>
                          <td className="p-3 text-right font-medium text-green-600">{formatRupiah(s.totalSales)}</td>
                          <td className="p-3 text-center">{s.totalTransactions}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Cash Movements Table */}
            <div className="card overflow-hidden">
              <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
                <h3 className="font-bold text-sm">Riwayat Arus Kas (Kas Masuk & Kas Keluar)</h3>
                <span className="text-xs text-slate-400">{filteredMovements.length} entri</span>
              </div>
              {filteredMovements.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-sm">
                  Belum ada arus kas tercatat pada periode ini.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-80 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800/80 border-b border-slate-100 dark:border-slate-700 sticky top-0 z-10 shadow-sm">
                      <tr>
                        <th className="text-left p-3 font-semibold">Tanggal</th>
                        <th className="text-left p-3 font-semibold">Kasir</th>
                        <th className="text-left p-3 font-semibold">Tipe</th>
                        <th className="text-left p-3 font-semibold">Kategori</th>
                        <th className="text-left p-3 font-semibold">Catatan</th>
                        <th className="text-right p-3 font-semibold">Nominal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredMovements.map((m) => (
                        <tr key={m.id} className="border-b border-slate-50 dark:border-slate-700/40">
                          <td className="p-3 text-xs text-slate-500">{formatDate(m.date)}</td>
                          <td className="p-3 font-medium">{m.cashierName}</td>
                          <td className="p-3">
                            {m.type === 'in' ? (
                              <span className="badge bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300 font-semibold">
                                + Kas Masuk
                              </span>
                            ) : (
                              <span className="badge bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300 font-semibold">
                                - Kas Keluar
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-xs font-semibold">{m.category}</td>
                          <td className="p-3 text-xs text-slate-500 max-w-xs truncate">{m.notes || '-'}</td>
                          <td className={`p-3 text-right font-bold ${m.type === 'in' ? 'text-green-600' : 'text-red-600'}`}>
                            {m.type === 'in' ? '+' : '-'}{formatRupiah(m.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Stock Opname Tab */}
      {activeTab === 'opname' && (() => {
        const filteredOpnames = opnameRecords.filter((r) => {
          const d = new Date(r.date);
          return d >= dateFrom && d <= dateTo;
        });
        const totalOpnameLoss = filteredOpnames.reduce((a, r) => a + r.totalLossValue, 0);
        const totalOpnameItems = filteredOpnames.reduce((a, r) => a + r.totalItems, 0);
        const totalOpnameDiffs = filteredOpnames.reduce((a, r) => a + r.itemsWithDifference, 0);
        // Aggregate loss per reason
        const lossPerReason: Record<string, number> = {};
        filteredOpnames.forEach((r) => {
          r.items.filter((i) => i.difference !== 0).forEach((i) => {
            const key = i.reason || 'Tidak Diketahui';
            lossPerReason[key] = (lossPerReason[key] || 0) + i.lossValue;
          });
        });
        const sortedReasons = Object.entries(lossPerReason).sort((a, b) => b[1] - a[1]);

        return (
          <div className="space-y-6">
            {/* Summary Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="card p-5">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                    <ClipboardCheck className="text-blue-600 dark:text-blue-400" size={22} />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Jumlah Opname</p>
                    <p className="text-xl font-bold">{filteredOpnames.length}</p>
                  </div>
                </div>
              </div>
              <div className="card p-5">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                    <Package className="text-amber-600 dark:text-amber-400" size={22} />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Total Item Diopname</p>
                    <p className="text-xl font-bold">{totalOpnameItems}</p>
                  </div>
                </div>
              </div>
              <div className="card p-5">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                    <AlertTriangle className="text-orange-600 dark:text-orange-400" size={22} />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Item Selisih</p>
                    <p className="text-xl font-bold text-amber-600">{totalOpnameDiffs}</p>
                  </div>
                </div>
              </div>
              <div className="card p-5">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                    <TrendingDown className="text-red-600 dark:text-red-400" size={22} />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Total Kerugian</p>
                    <p className={`text-xl font-bold ${totalOpnameLoss > 0 ? 'text-red-600' : 'text-green-600'}`}>{formatRupiah(totalOpnameLoss)}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Loss per Reason */}
            {sortedReasons.length > 0 && (
              <div className="card p-5">
                <h3 className="font-semibold text-sm mb-3">Kerugian per Alasan</h3>
                <div className="space-y-2">
                  {sortedReasons.map(([reason, loss]) => (
                    <div key={reason} className="flex items-center justify-between text-sm">
                      <span className="text-slate-600 dark:text-slate-400">{reason}</span>
                      <span className="font-semibold text-red-600">{formatRupiah(loss)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Opname Records Table */}
            <div className="card overflow-hidden">
              <div className="p-4 border-b border-slate-100 dark:border-slate-700">
                <h3 className="font-semibold text-sm">Riwayat Stock Opname</h3>
              </div>
              {filteredOpnames.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-sm">Tidak ada data stock opname pada periode ini.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800/80 border-b border-slate-100 dark:border-slate-700">
                      <tr>
                        <th className="text-left p-3 font-semibold">Tanggal</th>
                        <th className="text-left p-3 font-semibold">Petugas</th>
                        <th className="text-center p-3 font-semibold">Item</th>
                        <th className="text-center p-3 font-semibold">Selisih</th>
                        <th className="text-right p-3 font-semibold">Kerugian</th>
                        <th className="text-center p-3 font-semibold">PIN</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOpnames.map((rec) => (
                        <tr key={rec.id} className={`border-b border-slate-50 dark:border-slate-700/40 ${rec.totalLossValue > 0 ? 'bg-red-50/30 dark:bg-red-950/10' : ''}`}>
                          <td className="p-3 text-xs">{formatDate(rec.date)}</td>
                          <td className="p-3 font-medium">{rec.staffName}</td>
                          <td className="p-3 text-center">{rec.totalItems}</td>
                          <td className="p-3 text-center">
                            <span className={`font-semibold ${rec.itemsWithDifference > 0 ? 'text-amber-600' : 'text-green-600'}`}>{rec.itemsWithDifference}</span>
                          </td>
                          <td className="p-3 text-right">
                            <span className={`font-bold ${rec.totalLossValue > 0 ? 'text-red-600' : 'text-green-600'}`}>{formatRupiah(rec.totalLossValue)}</span>
                          </td>
                          <td className="p-3 text-center text-xs">
                            {rec.pinVerified ? <span className="text-green-600 font-medium">✓</span> : <span className="text-slate-300">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ============================================================
          H.3 Pilar 1 (v4.9.3): Modal Manager Force Close Shift
          Stats dihitung internal dari data tersinkron (computeShiftStats) —
          kasir menginput kas fisik, otorisasi via PinModal requireManager.
          ============================================================ */}
      {forceCloseTarget && (
        <Modal
          open={!!forceCloseTarget}
          onClose={() => { setForceCloseTarget(null); setForceCloseCash(''); }}
          title="Tutup Paksa Shift"
          maxWidth="max-w-md"
        >
          <div className="space-y-4">
            <div className="p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/40 rounded-xl text-xs text-amber-800 dark:text-amber-300 space-y-1">
              <p>
                <strong>Tutup paksa</strong> shift <strong>{forceCloseTarget.userName}</strong> (dibuka{' '}
                {new Date(forceCloseTarget.openedAt).toLocaleString('id-ID')}).
              </p>
              <p>
                Gunakan untuk shift gantung — device kasir rusak/mati atau kasir lupa tutup shift.
                Angka dihitung dari seluruh transaksi &amp; kas tersinkron dalam window shift ini.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="p-2 bg-slate-50 dark:bg-slate-800/60 rounded-lg">
                <p className="text-xs text-slate-500">Modal Awal</p>
                <p className="font-semibold">{formatRupiah(forceCloseTarget.openingCash)}</p>
              </div>
              <div className="p-2 bg-slate-50 dark:bg-slate-800/60 rounded-lg">
                <p className="text-xs text-slate-500">Total Penjualan</p>
                <p className="font-semibold">{formatRupiah(forceCloseStats?.totalSales ?? 0)}</p>
              </div>
              <div className="p-2 bg-slate-50 dark:bg-slate-800/60 rounded-lg">
                <p className="text-xs text-slate-500">Jumlah Transaksi</p>
                <p className="font-semibold">{forceCloseStats?.totalTx ?? 0} tx</p>
              </div>
              <div className="p-2 bg-slate-50 dark:bg-slate-800/60 rounded-lg">
                <p className="text-xs text-slate-500">Expected Cash</p>
                <p className="font-semibold text-brand-600 dark:text-brand-400">
                  {formatRupiah(forceCloseStats?.expectedCash ?? 0)}
                </p>
              </div>
            </div>

            <div>
              <label className="label">Kas Aktual di Laci (Rp) *</label>
              <input
                type="text"
                value={forceCloseCash}
                onChange={(e) => setForceCloseCash(e.target.value.replace(/\D/g, ''))}
                placeholder="Hitung kas fisik di laci, lalu input di sini"
                className="input font-semibold"
                autoFocus
              />
              {forceCloseCash && forceCloseStats && (
                <p className={`text-xs mt-1.5 font-medium ${parseInt(forceCloseCash) - forceCloseStats.expectedCash === 0 ? 'text-green-600' : 'text-red-500'}`}>
                  Selisih kas: {formatRupiah(parseInt(forceCloseCash) - forceCloseStats.expectedCash)}
                  {parseInt(forceCloseCash) - forceCloseStats.expectedCash === 0 ? ' (Pas)' : ''}
                </p>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => { setForceCloseTarget(null); setForceCloseCash(''); }}
                className="btn-secondary flex-1 py-2.5"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => setShowForceClosePin(true)}
                disabled={!forceCloseCash || parseInt(forceCloseCash) < 0}
                className="btn-primary flex-1 py-2.5 disabled:opacity-40"
              >
                Lanjut — Otorisasi Manager
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Otorisasi dual-control: sesi non-Manager wajib login cepat Manager (pola 10.2) */}
      <PinModal
        open={showForceClosePin}
        requireManager
        title="Otorisasi Tutup Paksa Shift"
        onClose={() => setShowForceClosePin(false)}
        onSuccess={() => {
          executeForceClose();
          setShowForceClosePin(false);
        }}
      />
    </div>
  );
}
