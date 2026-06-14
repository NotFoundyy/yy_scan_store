import type { StockMovement } from '../types/domain';
import { getDb } from '../lib/db';
import { nowIso } from '../lib/dates';
import { touchBox } from './boxes';
import { cloudEnabled, cloudExcludeMovements, cloudUpdateMovement, getCloudData } from '../lib/cloud';

export const listMovementsByBox = async (boxId: string) => {
  if (cloudEnabled()) {
    try {
      return (await getCloudData()).movements.filter((movement) => movement.boxId === boxId);
    } catch {
      // Use the last local cache while offline.
    }
  }
  const db = await getDb();
  const movements = await db.getAllFromIndex('movements', 'boxId', boxId);
  return movements.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

export const listAllMovements = async () => {
  if (cloudEnabled()) {
    try {
      return (await getCloudData()).movements;
    } catch {
      // Use the last local cache while offline.
    }
  }
  const db = await getDb();
  const movements = await db.getAll('movements');
  return movements.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

const movementSort = (a: StockMovement, b: StockMovement) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

const recalculateItemMovements = (movements: StockMovement[]) => {
  let stock = 0;
  return movements.sort(movementSort).map((movement) => {
    const beforeQuantity = stock;
    if (movement.type === 'in') stock += movement.quantity;
    if (movement.type === 'out') stock -= movement.quantity;
    if (movement.type === 'adjust') stock = movement.afterQuantity;
    if (stock < 0) throw new Error('编辑后库存不能为负数');
    return { ...movement, beforeQuantity, afterQuantity: stock };
  });
};

export const excludeOutboundMovementsFromExcelByTeams = async (input: { boxId: string; teamNames: string[] }) => {
  const teams = new Set(input.teamNames);
  if (!input.boxId || teams.size === 0) return 0;
  if (cloudEnabled()) return cloudExcludeMovements(input.boxId, [...teams]);

  const db = await getDb();
  const tx = db.transaction('movements', 'readwrite');
  const movements = await tx.store.index('boxId').getAll(input.boxId);
  const targets = movements.filter(
    (movement) => movement.type === 'out' && !movement.exportExcluded && teams.has(movement.teamName?.trim() || '未填班组'),
  );
  await Promise.all(targets.map((movement) => tx.store.put({ ...movement, exportExcluded: true })));
  await tx.done;
  return targets.length;
};

export const updateStockMovement = async (
  movement: StockMovement,
  input: { quantity: number; teamName?: string; note?: string; createdAt: string; imageDataUrl?: string },
) => {
  if (cloudEnabled()) {
    await cloudUpdateMovement(movement.id, input);
    return { ...movement, ...input };
  }
  if (input.quantity < 0) throw new Error('数量不能小于 0');
  const db = await getDb();
  const item = await db.get('items', movement.itemId);
  if (!item) throw new Error('物品不存在，无法编辑流水');

  const itemMovements = await db.getAllFromIndex('movements', 'itemId', movement.itemId);
  const updatedMovement: StockMovement = {
    ...movement,
    quantity: input.quantity,
    teamName: movement.type === 'out' ? input.teamName?.trim() : movement.teamName,
    note: input.note?.trim(),
    imageDataUrl: input.imageDataUrl,
    createdAt: input.createdAt,
  };
  const recalculated = recalculateItemMovements(itemMovements.map((entry) => (entry.id === movement.id ? updatedMovement : entry)));
  const finalQuantity = recalculated[recalculated.length - 1]?.afterQuantity ?? 0;

  const tx = db.transaction(['items', 'movements'], 'readwrite');
  await Promise.all(recalculated.map((entry) => tx.objectStore('movements').put(entry)));
  await tx.objectStore('items').put({ ...item, quantity: finalQuantity, updatedAt: nowIso() });
  await tx.done;
  await touchBox(movement.boxId);
  return recalculated.find((entry) => entry.id === movement.id) ?? updatedMovement;
};
