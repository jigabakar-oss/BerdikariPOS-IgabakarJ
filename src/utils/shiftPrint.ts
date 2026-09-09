/**
 * Shift Summary Print Helper — v4.11
 *
 * Single source of truth untuk pembuatan dan pencetakan ringkasan rekap shift kasir:
 * 1. Tutup Shift normal di Layout (isReprint = false)
 * 2. Cetak Ulang Rekap Shift di Laporan (isReprint = true)
 *
 * Mendukung pencetakan via Bluetooth ESC/POS dengan fallback browser print aman.
 */

import type { AppSettings, CashierShift, Transaction, CashMovement } from '../types';
import { formatRupiah } from './format';
import { computeShiftStats } from './shiftStats';
import { buildMenuSalesSummary } from './menuSalesSummary';
import { CUSTOM_ITEM_BUCKET_NAME } from './customItem';
import { printTextRaw } from './printer';

export interface BuildShiftSummaryParams {
  shift: CashierShift;
  storeName: string;
  transactions: Transaction[];
  movements: CashMovement[];
  cashierName?: string;
  closingCash?: number;
  isReprint?: boolean;
}

/**
 * Merangkai baris teks ringkasan shift untuk dicetak ke printer termal / dialog browser.
 */
export function buildShiftSummaryLines(params: BuildShiftSummaryParams): string[] {
  const { shift, storeName, transactions, movements, cashierName, closingCash, isReprint } = params;

  const openedDate = new Date(shift.openedAt);
  const closedDate = shift.closedAt ? new Date(shift.closedAt) : new Date();
  const closedAtMs = shift.closedAt ? closedDate.getTime() : undefined;
  const openedAtMs = openedDate.getTime();

  // Filter transaksi dalam window shift (Selesai & bukan sub-bill split)
  const shiftTxs = transactions.filter((t) => {
    if (t.txStatus !== 'Selesai' || t.splitParentId) return false;
    const td = new Date(t.date).getTime();
    if (closedAtMs) {
      return td >= openedAtMs && td <= closedAtMs;
    }
    return td >= openedAtMs;
  });

  const stats = computeShiftStats(shift, transactions, movements);
  const menuSalesSorted = buildMenuSalesSummary(shiftTxs);
  const totalItemQty = menuSalesSorted.reduce((a, r) => a + r.qty, 0);

  const effectiveClosingCash = closingCash !== undefined ? closingCash : shift.closingCash;
  const effectiveExpectedCash =
    shift.expectedCash !== undefined && shift.status === 'closed'
      ? shift.expectedCash
      : stats.expectedCash;

  const effectiveCashier = cashierName || shift.userName || 'Kasir';

  const lines = [
    `=== RINGKASAN TRANSAKSI ===`,
    ...(isReprint ? [`*** CETAK ULANG ***`] : []),
    `${storeName}`,
    `Tanggal: ${openedDate.toLocaleDateString('id-ID')}`,
    `Jam Mulai: ${openedDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`,
    `Jam Tutup: ${
      shift.closedAt
        ? closedDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
        : shift.status === 'open'
        ? 'Shift Masih Berjalan'
        : closedDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    }`,
    `Kasir: ${effectiveCashier}`,
    ...(shift.closedBy && shift.closedBy !== effectiveCashier
      ? [`Ditutup Oleh: ${shift.closedBy}`]
      : []),
    ``,
    `Modal Awal: ${formatRupiah(shift.openingCash || 0)}`,
    `Total Penjualan: ${formatRupiah(stats.totalSales)}`,
    `  - Tunai (Cash): ${formatRupiah(stats.cashSales || 0)}`,
    `  - QRIS: ${formatRupiah(stats.qrisSales || 0)}`,
    `  - Transfer: ${formatRupiah(stats.transferSales || 0)}`,
    `Jumlah Transaksi: ${stats.totalTx}`,
    `Total Item Terjual: ${totalItemQty} item`,
    `Kas Masuk: +${formatRupiah(stats.cashIn || 0)}`,
    `Kas Keluar: -${formatRupiah(stats.cashOut || 0)}`,
    ...(stats.refundedCashSales > 0
      ? [`Refund Tunai (dikembalikan): -${formatRupiah(stats.refundedCashSales)}`]
      : []),
    ``,
    ...(menuSalesSorted.length > 0
      ? [
          `--- Penjualan Menu ---`,
          ...menuSalesSorted.flatMap((data) => {
            const unitPrice = data.qty > 0 ? Math.round(data.revenue / data.qty) : 0;
            const rows = [
              `${data.name}`,
              `  ${data.qty} x ${formatRupiah(unitPrice)}          ${formatRupiah(data.revenue)}`,
            ];
            // v4.10 P.4: baris bucket "Item Non-Menu" menampilkan LABA KOTOR (revenue − customHpp)
            if (data.name === CUSTOM_ITEM_BUCKET_NAME) {
              rows.push(`  Laba Kotor: ${formatRupiah(data.profit)}`);
            }
            return rows;
          }),
          ``,
        ]
      : []),
    `Expected Cash: ${formatRupiah(effectiveExpectedCash)}`,
    ...(effectiveClosingCash !== undefined
      ? [
          `Kas Aktual (Fisik): ${formatRupiah(effectiveClosingCash)}`,
          `Selisih Kas: ${formatRupiah(effectiveClosingCash - effectiveExpectedCash)}`,
        ]
      : []),
    ``,
    // H.2 (v4.9.3): rekap per metode pembayaran — hemat kertas thermal
    `--- Riwayat Transaksi ---`,
    ...(() => {
      const salesTx = shiftTxs.filter((t) => !t.refunded);
      const qris = salesTx.filter((t) => t.paymentMethod === 'QRIS').length;
      const transfer = salesTx.filter((t) => t.paymentMethod === 'Transfer').length;
      const cash = salesTx.filter((t) => t.paymentMethod === 'Cash').length;
      const other = salesTx.length - (qris + transfer + cash);
      const rows = [
        `QRIS      | ${qris} Pelanggan`,
        `Transfer  | ${transfer} Pelanggan`,
        `Cash      | ${cash} Pelanggan`,
      ];
      if (other > 0) rows.push(`Lainnya    | ${other} Pelanggan`);
      return rows;
    })(),
    ``,
    `===========================`,
  ];

  return lines;
}

/**
 * Mencetak ringkasan shift kasir ke printer kasir terkonfigurasi.
 */
export async function printShiftSummary(
  params: BuildShiftSummaryParams,
  settings: AppSettings
): Promise<boolean> {
  const lines = buildShiftSummaryLines(params);
  return await printTextRaw(lines, settings);
}
