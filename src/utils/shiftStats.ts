import type { CashierShift, Transaction, CashMovement } from '../types';

export interface ShiftStats {
  totalSales: number;
  totalTx: number;
  expectedCash: number;
  cashIn: number;
  cashOut: number;
  cashSales: number;
  qrisSales: number;
  transferSales: number;
  /**
   * v4.7 TO DO 20.1: penjualan TUNAI yang di-refund dalam window shift.
   * Dipakai agar expectedCash tetap netral: uang tunai benar-benar masuk laci dari
   * penjualan itu (lalu keluar lagi via movement Kas Keluar 'Refund'). Tanpa ini,
   * meng-exclude refunded dari cashSales akan double-subtract (sale tidak dihitung
   * tapi movement refund tetap di cashOut → expectedCash = opening − refund).
   */
  refundedCashSales: number;
}

export const EMPTY_SHIFT_STATS: ShiftStats = {
  totalSales: 0,
  totalTx: 0,
  expectedCash: 0,
  cashIn: 0,
  cashOut: 0,
  cashSales: 0,
  qrisSales: 0,
  transferSales: 0,
  refundedCashSales: 0,
};

/**
 * v4.7 TO DO 18.3 — Expected cash tutup shift dihitung dari SEMUA transaksi Selesai
 * tersinkron dalam window shift (1 shift aktif per outlet → laci dipakai bersama),
 * BUKAN hanya transaksi lokal device / kasir tertentu.
 *
 * Aturan:
 * - Transaksi: txStatus === 'Selesai', bukan sub-bill split (sudah terhitung di induk),
 *   dan date >= openedAt shift.
 * - Semua kasir dihitung (tidak ada filter cashierId) — konsisten dengan model 1 shift
 *   per outlet di shiftStore (openShift guard + restore shift terbuka paling awal).
 * - Kas Masuk/Keluar: dipilih via shiftId bila tersedia, fallback window waktu (semua
 *   kasir — laci bersama), sama seperti perilaku lama.
 * - v4.7 TO DO 20.1: totalSales/totalTx & rincian metode mengecualikan transaksi yang
 *   SUDAH di-refund (konsisten dengan Dashboard/Reports/Transactions). Expected cash
 *   tetap netral karena refundedCashSales (uang tunai yang masuk lalu keluar via
 *   movement 'out' Refund) ditambahkan kembali ke formula.
 * - expectedCash = openingCash + cashSales + refundedCashSales + cashIn - cashOut.
 */
export function computeShiftStats(
  activeShift: CashierShift,
  transactions: Transaction[],
  movements: CashMovement[]
): ShiftStats {
  const openedAtMs = new Date(activeShift.openedAt).getTime();
  const closedAtMs = activeShift.closedAt ? new Date(activeShift.closedAt).getTime() : undefined;

  const shiftTx = transactions.filter(
    (t) =>
      t.txStatus === 'Selesai' &&
      !t.splitParentId &&
      new Date(t.date).getTime() >= openedAtMs &&
      (!closedAtMs || new Date(t.date).getTime() <= closedAtMs)
  );

  // v4.7 TO DO 20.1: basis LAPORAN = transaksi yang belum di-refund (pendapatan yang
  // sudah dikembalikan tidak lagi dihitung sebagai penjualan).
  const salesTx = shiftTx.filter((t) => !t.refunded);

  const totalSales = salesTx.reduce((a, t) => a + t.totalAmount, 0);

  const cashSales = salesTx
    .filter((t) => t.paymentMethod === 'Cash')
    .reduce((a, t) => a + t.totalAmount, 0);
  const qrisSales = salesTx
    .filter((t) => t.paymentMethod === 'QRIS')
    .reduce((a, t) => a + t.totalAmount, 0);
  const transferSales = salesTx
    .filter((t) => t.paymentMethod === 'Transfer')
    .reduce((a, t) => a + t.totalAmount, 0);

  // Penjualan TUNAI yang di-refund dalam window — uangnya masuk laci, lalu keluar lagi
  // via movement Kas Keluar 'Refund' (dicatat di cashOut di bawah). Keduanya saling
  // meniadakan di expectedCash — persis seperti perilaku lama, hanya kini angka laporan
  // (totalSales/cashSales) sudah bersih dari transaksi refunded.
  const refundedCashSales = shiftTx
    .filter((t) => t.refunded && t.paymentMethod === 'Cash')
    .reduce((a, t) => a + t.totalAmount, 0);

  // Kas Masuk & Kas Keluar selama shift — shiftId match lebih diutamakan;
  // fallback: window waktu (semua kasir, karena laci fisik dipakai bersama).
  const shiftMovements = movements.filter((m) => {
    if (m.shiftId && m.shiftId === activeShift.id) return true;
    const mTime = new Date(m.date).getTime();
    if (closedAtMs) {
      return mTime >= openedAtMs - 60000 && mTime <= closedAtMs + 60000;
    }
    return mTime >= openedAtMs - 60000;
  });
  const cashIn = shiftMovements
    .filter((m) => m.type === 'in')
    .reduce((a, m) => a + m.amount, 0);
  const cashOut = shiftMovements
    .filter((m) => m.type === 'out')
    .reduce((a, m) => a + m.amount, 0);

  const expectedCash = activeShift.openingCash + cashSales + refundedCashSales + cashIn - cashOut;

  return {
    totalSales,
    totalTx: salesTx.length,
    expectedCash,
    cashIn,
    cashOut,
    cashSales,
    qrisSales,
    transferSales,
    refundedCashSales,
  };
}
