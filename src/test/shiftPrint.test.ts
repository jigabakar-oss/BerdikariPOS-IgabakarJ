import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildShiftSummaryLines, printShiftSummary } from '../utils/shiftPrint';
import type { AppSettings, CashierShift, Transaction, CashMovement } from '../types';
import { CUSTOM_ITEM_BUCKET_NAME } from '../utils/customItem';

let windowBackup: any;
let documentBackup: any;

function installFakeDom() {
  const doc = {
    getElementById: vi.fn(() => null),
    createElement: vi.fn(() => ({
      id: '',
      style: {},
      contentWindow: { print: vi.fn() },
      contentDocument: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
    })),
    body: { appendChild: vi.fn() },
  };
  (globalThis as any).document = doc;
}

beforeEach(() => {
  windowBackup = (globalThis as any).window;
  (globalThis as any).window = { setTimeout: () => 0, open: () => null };
  documentBackup = (globalThis as any).document;
  installFakeDom();
});

afterEach(() => {
  (globalThis as any).window = windowBackup;
  (globalThis as any).document = documentBackup;
});

const defaultSettings: AppSettings = {
  managerPin: '1234',
  superAdminPin: '000000',
  storeName: 'Kopi Lele',
  address: 'Jl. Merdeka No. 1',
  receiptFooter: 'Terima kasih',
  categories: ['Kopi', 'Non-Kopi'],
  printerWidth: '58mm',
  printerType: 'browser',
  printerEnabled: true,
  autoPrintOnCheckout: false,
  demoMode: false,
};

const baseShift: CashierShift = {
  id: 'shift-101',
  userId: 'u1',
  userName: 'Kasir Budi',
  openedAt: '2026-09-08T08:00:00.000Z',
  openingCash: 150000,
  totalSales: 0,
  totalTransactions: 0,
  status: 'open',
};

const makeTx = (over: Partial<Transaction> & { id: string; date: string }): Transaction => ({
  queueNumber: 1,
  items: [
    {
      lineId: 'line-1',
      menuId: 'm1',
      name: 'Kopi Susu',
      basePrice: 15000,
      quantity: 2,
      subtotal: 30000,
      temperature: 'Dingin',
      sugar: 'Normal',
      addons: [],
    },
  ],
  subtotal: 30000,
  discount: 0,
  totalAmount: 30000,
  paymentMethod: 'Cash',
  kitchenStatus: 'Done',
  txStatus: 'Selesai',
  cashierId: 'u1',
  cashierName: 'Kasir Budi',
  hpp: 10000,
  ...over,
});

const makeMv = (over: Partial<CashMovement> & { id: string; date: string }): CashMovement => ({
  type: 'in',
  amount: 0,
  category: 'Lain-lain',
  cashierId: 'u1',
  cashierName: 'Kasir Budi',
  createdAt: over.date,
  ...over,
});

describe('shiftPrint — buildShiftSummaryLines & printShiftSummary', () => {
  it('membentuk baris ringkasan shift normal (isReprint = false) tanpa tanda cetak ulang', () => {
    const txs: Transaction[] = [
      makeTx({ id: 't1', date: '2026-09-08T09:00:00.000Z', totalAmount: 30000, paymentMethod: 'Cash' }),
      makeTx({ id: 't2', date: '2026-09-08T10:00:00.000Z', totalAmount: 20000, paymentMethod: 'QRIS' }),
    ];
    const mvs: CashMovement[] = [
      makeMv({ id: 'm1', date: '2026-09-08T09:30:00.000Z', type: 'in', amount: 50000, category: 'Modal Tambahan' }),
      makeMv({ id: 'm2', date: '2026-09-08T11:00:00.000Z', type: 'out', amount: 10000, category: 'Beli Es' }),
    ];

    const lines = buildShiftSummaryLines({
      shift: baseShift,
      storeName: 'Kopi Lele',
      transactions: txs,
      movements: mvs,
      cashierName: 'Kasir Budi',
      closingCash: 220000,
      isReprint: false,
    });

    expect(lines).toContain('=== RINGKASAN TRANSAKSI ===');
    expect(lines).not.toContain('*** CETAK ULANG ***');
    expect(lines).toContain('Kopi Lele');
    expect(lines).toContain('Kasir: Kasir Budi');
    expect(lines.some((l) => l.includes('Modal Awal:') && l.includes('150.000'))).toBe(true);
    expect(lines.some((l) => l.includes('Total Penjualan:') && l.includes('50.000'))).toBe(true);
    expect(lines.some((l) => l.includes('Tunai (Cash):') && l.includes('30.000'))).toBe(true);
    expect(lines.some((l) => l.includes('QRIS:') && l.includes('20.000'))).toBe(true);
    expect(lines.some((l) => l.includes('Kas Masuk: +') && l.includes('50.000'))).toBe(true);
    expect(lines.some((l) => l.includes('Kas Keluar: -') && l.includes('10.000'))).toBe(true);
    // Expected cash = 150000 + 30000 + 50000 - 10000 = 220000
    expect(lines.some((l) => l.includes('Expected Cash:') && l.includes('220.000'))).toBe(true);
    expect(lines.some((l) => l.includes('Kas Aktual (Fisik):') && l.includes('220.000'))).toBe(true);
    expect(lines.some((l) => l.includes('Selisih Kas:') && l.includes('0'))).toBe(true);
  });

  it('menyertakan penanda *** CETAK ULANG *** saat isReprint = true', () => {
    const closedShift: CashierShift = {
      ...baseShift,
      closedAt: '2026-09-08T17:00:00.000Z',
      closingCash: 250000,
      expectedCash: 250000,
      cashDifference: 0,
      totalSales: 100000,
      totalTransactions: 4,
      status: 'closed',
    };

    const lines = buildShiftSummaryLines({
      shift: closedShift,
      storeName: 'Kopi Lele',
      transactions: [],
      movements: [],
      cashierName: 'Kasir Budi',
      isReprint: true,
    });

    expect(lines[0]).toBe('=== RINGKASAN TRANSAKSI ===');
    expect(lines[1]).toBe('*** CETAK ULANG ***');
    expect(lines.some((l) => l.includes('Kas Aktual (Fisik):') && l.includes('250.000'))).toBe(true);
  });

  it('menampilkan agregasi menu & laba kotor item non-menu', () => {
    const txs: Transaction[] = [
      makeTx({
        id: 't1',
        date: '2026-09-08T09:00:00.000Z',
        items: [
          {
            lineId: 'l1',
            menuId: 'm1',
            name: 'Kopi Susu',
            basePrice: 15000,
            quantity: 2,
            subtotal: 30000,
            temperature: 'Dingin',
            sugar: 'Normal',
            addons: [],
          },
          {
            lineId: 'l2',
            menuId: 'custom:manual_1',
            isCustom: true,
            name: 'Keripik Tempe',
            basePrice: 10000,
            quantity: 3,
            subtotal: 30000,
            customHpp: 6000,
            hpp: 18000,
            temperature: 'Dingin',
            sugar: 'Normal',
            addons: [],
          },
        ],
        totalAmount: 60000,
      }),
    ];

    const lines = buildShiftSummaryLines({
      shift: baseShift,
      storeName: 'Kopi Lele',
      transactions: txs,
      movements: [],
      isReprint: false,
    });

    expect(lines).toContain('--- Penjualan Menu ---');
    expect(lines.some((l) => l.includes('Kopi Susu'))).toBe(true);
    expect(lines.some((l) => l.includes(CUSTOM_ITEM_BUCKET_NAME))).toBe(true);
    // Laba kotor keripik = 30000 - 18000 = 12000
    expect(lines.some((l) => l.includes('Laba Kotor:') && l.includes('12.000'))).toBe(true);
  });

  it('memproses printShiftSummary tanpa error dengan fallback printer', async () => {
    const res = await printShiftSummary(
      {
        shift: baseShift,
        storeName: 'Kopi Lele',
        transactions: [],
        movements: [],
        isReprint: true,
      },
      defaultSettings
    );

    expect(res).toBe(true);
  });
});
