import { and, asc, eq, inArray } from 'drizzle-orm';
import { calculateBill, normalizeMobile, type BillInput, type BillItemInput, type BillUpdateInput, type InvoiceTaxMode } from '@erp/shared';
import { db, schema } from '../db/client';
import { notFound, validation } from '../lib/errors';
import { allocateBillNumber } from './billNumbers';

/**
 * Bill business rules. The route validates the payload and authorizes; this owns everything
 * that touches more than one row — proving the book, the optional appointment and every
 * item/sub item pair belong to the tenant, reading the master values the lines snapshot,
 * taking the bill number, calculating the money and writing the header and its lines together.
 *
 * Three rules run through all of it:
 *
 *  1. **The client is never the source of a snapshot or an amount.** It sends identifiers and
 *     the values the operator typed. Item name, product name, HSN and GST % are read here
 *     from the masters; every amount is recomputed here from the validated lines.
 *  2. **A bill is history.** Its customer fields are its own, never a view of the appointment,
 *     and a line that already exists keeps the snapshot it was created with even when the
 *     master has moved on since.
 *  3. **The number is taken inside the insert's transaction**, so a bill that fails to save
 *     rolls its number back with it instead of burning one. Nothing here ever previews a
 *     number — see `docs/BILL_NUMBERING.md`.
 *
 * Not in this phase, deliberately: discount, advance, payment, outstanding, any accounting
 * posting, delivery workflow, draft/cancelled status and the CGST/SGST/IGST split.
 */

/** `db`, or the transaction handle inside `db.transaction(...)` — the same shape the services use. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const B = schema.bills;
const BI = schema.billItems;

/* ----------------------------------------------------------------- shaping -- */

/** API shape: `numeric` comes back from Postgres as a string. */
export const shapeBill = <T extends { subTotal: unknown; gstAmount: unknown; grandTotal: unknown }>(row: T) => ({
  ...row,
  subTotal: Number(row.subTotal),
  gstAmount: Number(row.gstAmount),
  grandTotal: Number(row.grandTotal),
});

export const shapeBillItem = <T extends { gstRateSnapshot: unknown; quantity: unknown; rate: unknown; taxableAmount: unknown; gstAmount: unknown; lineTotal: unknown }>(row: T) => ({
  ...row,
  gstRateSnapshot: Number(row.gstRateSnapshot),
  quantity: Number(row.quantity),
  rate: Number(row.rate),
  taxableAmount: Number(row.taxableAmount),
  gstAmount: Number(row.gstAmount),
  lineTotal: Number(row.lineTotal),
});

/* ------------------------------------------------------------ master reads -- */

/**
 * The book this bill is numbered under, proven to belong to the tenant.
 *
 * A NEW bill may only use an ACTIVE book: deactivating a book is how the studio closes a
 * series, and the lookup already offers active books only. An EDIT does not re-check it —
 * the bill is already numbered under that book, and a book retired afterwards must not make
 * its own history unsaveable.
 *
 * `bills_book_tenant_fk` makes a cross-tenant book structurally impossible anyway; this turns
 * that into a message the form can attach to the right field.
 */
async function resolveBook(exec: Executor, tenantId: string, bookId: string, requireActive: boolean) {
  const [book] = await exec
    .select({ id: schema.books.id, bookNumber: schema.books.bookNumber, isActive: schema.books.isActive })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.tenantId, tenantId)))
    .limit(1);
  if (!book) throw validation('Select a valid book', [{ path: ['bookId'], message: 'This book does not exist' }]);
  if (requireActive && !book.isActive) {
    throw validation(`Book "${book.bookNumber}" is inactive and cannot be used for a new bill`, [{ path: ['bookId'], message: 'This book is inactive' }]);
  }
  return book;
}

/**
 * The booking this bill came from, proven to belong to the tenant. Optional: a walk-in
 * customer has none. The appointment is traceability only — nothing is copied from it here,
 * because the customer values the bill stores are the ones the operator confirmed on the form.
 */
async function resolveAppointment(exec: Executor, tenantId: string, appointmentId: string) {
  const [appointment] = await exec
    .select({ id: schema.appointments.id, appointmentNumber: schema.appointments.appointmentNumber })
    .from(schema.appointments)
    .where(and(eq(schema.appointments.id, appointmentId), eq(schema.appointments.tenantId, tenantId)))
    .limit(1);
  if (!appointment) throw validation('Select a valid appointment', [{ path: ['appointmentId'], message: 'This appointment does not exist' }]);
  return appointment;
}

/* ------------------------------------------------------------------- lines -- */

/** The master values a line prints. Once a line exists, these are frozen on it. */
interface LineSnapshot {
  itemNameSnapshot: string;
  subItemNameSnapshot: string;
  hsnCodeSnapshot: string;
  gstRateSnapshot: number;
}

/** One line is identified by its product, which is what decides whether its snapshot is new. */
const pairKey = (itemId: string, subItemId: string) => `${itemId}|${subItemId}`;

/**
 * Validate every line against the masters and turn it into a row.
 *
 * Two master queries for the whole bill, never one per line: the ids are collected first and
 * fetched with `IN (...)`.
 *
 * `existing` carries the snapshots the bill already holds, keyed by item+product. A line whose
 * product is already on the bill KEEPS its original snapshot — re-saving a bill after Item
 * Master's GST changed must not silently reprice history. Only a product that is new to this
 * bill takes a fresh snapshot, and only a new product has to be active: an old line may go on
 * referring to a master row the studio has since retired.
 *
 * Keyed by PRODUCT rather than by line, deliberately: if the operator adds a second line for a
 * product the bill already carries, that line takes the rate this document already used for it
 * rather than today's. One invoice then cannot print two different GST rates for the same
 * product, which is the outcome that would actually be wrong on paper. The cost is that such a
 * line skips the active check — it is a product this bill already bills, so the document stays
 * self-consistent, and a retired product still cannot be added to a bill that never had it.
 */
async function resolveLines(
  exec: Executor,
  tenantId: string,
  lines: BillItemInput[],
  taxMode: InvoiceTaxMode,
  existing: Map<string, LineSnapshot>,
) {
  const itemIds = Array.from(new Set(lines.map((l) => l.itemId)));
  const subItemIds = Array.from(new Set(lines.map((l) => l.subItemId)));

  const itemRows = await exec
    .select({ id: schema.items.id, itemName: schema.items.itemName, hsnCode: schema.items.hsnCode, gstRate: schema.items.gstRate, isActive: schema.items.isActive })
    .from(schema.items)
    .where(and(eq(schema.items.tenantId, tenantId), inArray(schema.items.id, itemIds)));
  const subItemRows = await exec
    .select({ id: schema.subItems.id, itemId: schema.subItems.itemId, productName: schema.subItems.productName, isActive: schema.subItems.isActive })
    .from(schema.subItems)
    .where(and(eq(schema.subItems.tenantId, tenantId), inArray(schema.subItems.id, subItemIds)));

  const itemById = new Map(itemRows.map((r) => [r.id, r]));
  const subItemById = new Map(subItemRows.map((r) => [r.id, r]));

  const snapshots: LineSnapshot[] = lines.map((line, i) => {
    const at = (field: string, message: string) => validation(message, [{ path: ['items', i, field], message }]);
    const item = itemById.get(line.itemId);
    if (!item) throw at('itemId', 'This item does not exist');
    const subItem = subItemById.get(line.subItemId);
    if (!subItem) throw at('subItemId', 'This product does not exist');
    /**
     * The relationship is proven here, never in the browser: a payload may name any product
     * with any item, and only the database knows which item a product actually hangs off.
     */
    if (subItem.itemId !== line.itemId) throw at('subItemId', `"${subItem.productName}" does not belong to "${item.itemName}"`);

    const kept = existing.get(pairKey(line.itemId, line.subItemId));
    if (kept) return kept;
    // New to this bill, so it is being chosen now — and a retired master is not selectable.
    if (!item.isActive) throw at('itemId', `"${item.itemName}" is inactive and cannot be added to a bill`);
    if (!subItem.isActive) throw at('subItemId', `"${subItem.productName}" is inactive and cannot be added to a bill`);
    return {
      itemNameSnapshot: item.itemName,
      subItemNameSnapshot: subItem.productName,
      hsnCodeSnapshot: item.hsnCode,
      gstRateSnapshot: Number(item.gstRate),
    };
  });

  /**
   * The money, from the one shared calculation both apps use — the browser's preview and this
   * are the same function, and this one is what gets stored.
   */
  const calculated = calculateBill(
    lines.map((l, i) => ({ quantity: l.quantity, rate: l.rate, gstRate: snapshots[i].gstRateSnapshot })),
    taxMode,
  );

  const rows = lines.map((line, i) => ({
    // 1, 2, 3 … in payload order: the invoice prints in exactly the order the operator entered.
    lineNumber: i + 1,
    itemId: line.itemId,
    subItemId: line.subItemId,
    ...snapshots[i],
    gstRateSnapshot: snapshots[i].gstRateSnapshot.toFixed(2),
    quantity: line.quantity.toFixed(2),
    rate: line.rate.toFixed(2),
    taxableAmount: calculated.lines[i].taxableAmount.toFixed(2),
    gstAmount: calculated.lines[i].gstAmount.toFixed(2),
    lineTotal: calculated.lines[i].lineTotal.toFixed(2),
    remark: line.remark,
  }));

  return { rows, totals: calculated.totals };
}

/** The snapshots a bill's current lines hold, so an edit can keep them. */
async function existingSnapshots(exec: Executor, tenantId: string, billId: string) {
  const rows = await exec
    .select({
      itemId: BI.itemId,
      subItemId: BI.subItemId,
      itemNameSnapshot: BI.itemNameSnapshot,
      subItemNameSnapshot: BI.subItemNameSnapshot,
      hsnCodeSnapshot: BI.hsnCodeSnapshot,
      gstRateSnapshot: BI.gstRateSnapshot,
    })
    .from(BI)
    .where(and(eq(BI.tenantId, tenantId), eq(BI.billId, billId)));
  return new Map(
    rows.map((r) => [
      pairKey(r.itemId, r.subItemId),
      { itemNameSnapshot: r.itemNameSnapshot, subItemNameSnapshot: r.subItemNameSnapshot, hsnCodeSnapshot: r.hsnCodeSnapshot, gstRateSnapshot: Number(r.gstRateSnapshot) },
    ]),
  );
}

/* -------------------------------------------------------------- header row -- */

/**
 * Validated body -> header values. The only place `mobileSearch` is ever written: it is
 * derived from what the operator typed by the shared `normalizeMobile`, never accepted from a
 * client, so Billing and Appointments always agree on what a number matches.
 */
function headerRow(body: Omit<BillUpdateInput, 'items'>): Record<string, unknown> {
  return {
    appointmentId: body.appointmentId,
    billDate: body.billDate,
    deliveryDate: body.deliveryDate,
    customerName: body.customerName,
    mobileNumber: body.mobileNumber,
    mobileSearch: normalizeMobile(body.mobileNumber),
    babyName: body.babyName,
    hasBirthDate: body.hasBirthDate,
    // The schema already nulls this when the checkbox is off; the column's check is the backstop.
    birthDate: body.hasBirthDate ? body.birthDate : null,
    remark: body.remark,
    taxMode: body.taxMode,
  };
}

/* --------------------------------------------------------------- public API -- */

/** A bill row as the API returns it: the stored columns, with `numeric` read back as numbers. */
export type BillShaped = Omit<typeof B.$inferSelect, 'subTotal' | 'gstAmount' | 'grandTotal'> & { subTotal: number; gstAmount: number; grandTotal: number };
export type BillItemShaped = Omit<typeof BI.$inferSelect, 'gstRateSnapshot' | 'quantity' | 'rate' | 'taxableAmount' | 'gstAmount' | 'lineTotal'> & {
  gstRateSnapshot: number;
  quantity: number;
  rate: number;
  taxableAmount: number;
  gstAmount: number;
  lineTotal: number;
};

export interface BillRecord extends BillShaped {
  bookNumber: string;
  /** The booking this bill came from, for display only. Null for a walk-in customer. */
  appointmentNumber: number | null;
  items: BillItemShaped[];
}

/** One bill with its book's number, its booking's number and its lines in print order. */
export async function getBill(tenantId: string, id: string): Promise<BillRecord> {
  const [row] = await db
    .select({ bill: B, bookNumber: schema.books.bookNumber, appointmentNumber: schema.appointments.appointmentNumber })
    .from(B)
    .innerJoin(schema.books, eq(schema.books.id, B.bookId))
    // Left: the appointment is optional, and a bill without one must still load.
    .leftJoin(schema.appointments, eq(schema.appointments.id, B.appointmentId))
    .where(and(eq(B.id, id), eq(B.tenantId, tenantId)))
    .limit(1);
  if (!row) throw notFound('Bill');
  // One query for the lines, not one per line, and ordered by the stored line number rather
  // than by insertion time — the invoice's order is data, not a side effect.
  const lines = await db.select().from(BI).where(and(eq(BI.tenantId, tenantId), eq(BI.billId, id))).orderBy(asc(BI.lineNumber));
  return { ...shapeBill(row.bill), bookNumber: row.bookNumber, appointmentNumber: row.appointmentNumber ?? null, items: lines.map(shapeBillItem) };
}

/**
 * Create a bill, take its number and write its lines — all in ONE transaction.
 *
 * Order matters: everything that can be refused is refused before the number is taken, so a
 * rejected bill normally never reaches the allocator at all. If anything after it fails, the
 * transaction rolls back and `books.next_bill_number` goes back with it — the number is not
 * burned. Nothing else in this file ever calls the allocator.
 */
export async function createBill(tenantId: string, body: BillInput): Promise<BillRecord> {
  return db.transaction(async (tx) => {
    const book = await resolveBook(tx, tenantId, body.bookId, true);
    const appointment = body.appointmentId ? await resolveAppointment(tx, tenantId, body.appointmentId) : null;
    const { rows, totals } = await resolveLines(tx, tenantId, body.items, body.taxMode, new Map());

    const billNumber = await allocateBillNumber(tx, tenantId, book.id);

    const [bill] = await tx
      .insert(B)
      .values({
        ...(headerRow(body) as typeof B.$inferInsert),
        tenantId,
        bookId: book.id,
        billNumber,
        subTotal: totals.subTotal.toFixed(2),
        gstAmount: totals.gstAmount.toFixed(2),
        grandTotal: totals.grandTotal.toFixed(2),
      })
      .returning();

    const lines = await tx
      .insert(BI)
      .values(rows.map((r) => ({ ...r, tenantId, billId: bill.id })))
      .returning();

    return { ...shapeBill(bill), bookNumber: book.bookNumber, appointmentNumber: appointment?.appointmentNumber ?? null, items: lines.map(shapeBillItem) };
  });
}

/**
 * Update a bill's header and replace its lines, in ONE transaction.
 *
 * The bill's identity is fixed: the book and the bill number are not editable, and
 * `billUpdateSchema` has no field for either — so no edit allocates a number or moves a
 * counter. The lines are replaced as a SET (deleted, then re-inserted in payload order), which
 * is what keeps `lineNumber` a deterministic 1, 2, 3 … and the stored totals honest, and what
 * lets the operator reorder or remove a line without a per-row diffing protocol.
 *
 * Snapshots survive the replacement for every product the bill already had — see
 * `resolveLines`.
 */
export async function updateBill(tenantId: string, id: string, body: BillUpdateInput): Promise<BillRecord> {
  return db.transaction(async (tx) => {
    /**
     * Lock the bill for the transaction. The lines are replaced as a set, so two operators
     * saving the same bill at the same instant would otherwise both delete and re-insert and
     * collide on `bill_items_bill_line_uk` — no corruption, but a 500 instead of the second
     * save simply queueing behind the first.
     */
    const [existing] = await tx.select().from(B).where(and(eq(B.id, id), eq(B.tenantId, tenantId))).limit(1).for('update');
    if (!existing) throw notFound('Bill');

    // Not re-checked for active: this bill is already numbered under this book.
    const book = await resolveBook(tx, tenantId, existing.bookId, false);
    const appointment = body.appointmentId ? await resolveAppointment(tx, tenantId, body.appointmentId) : null;
    const { rows, totals } = await resolveLines(tx, tenantId, body.items, body.taxMode, await existingSnapshots(tx, tenantId, id));

    const [bill] = await tx
      .update(B)
      .set({
        ...headerRow(body),
        subTotal: totals.subTotal.toFixed(2),
        gstAmount: totals.gstAmount.toFixed(2),
        grandTotal: totals.grandTotal.toFixed(2),
        updatedAt: new Date(),
      })
      .where(and(eq(B.id, id), eq(B.tenantId, tenantId)))
      .returning();

    await tx.delete(BI).where(and(eq(BI.tenantId, tenantId), eq(BI.billId, id)));
    const lines = await tx
      .insert(BI)
      .values(rows.map((r) => ({ ...r, tenantId, billId: id })))
      .returning();

    return { ...shapeBill(bill), bookNumber: book.bookNumber, appointmentNumber: appointment?.appointmentNumber ?? null, items: lines.map(shapeBillItem) };
  });
}
