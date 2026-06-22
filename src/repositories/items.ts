import type { Item, StockMovement } from '../types/domain';
import { getDb } from '../lib/db';
import { nowIso } from '../lib/dates';
import { createId } from '../lib/ids';
import { touchBox } from './boxes';
import { cloudChangeStock, cloudCreateItem, cloudDeleteItem, cloudEnabled, cloudUpdateItem, getCloudData } from '../lib/cloud';

export const listItemsByBox = async (boxId: string) => {
  if (cloudEnabled()) {
    try {
      const rows = (await getCloudData()).items.filter((item) => item.boxId === boxId);
      return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    } catch {
      // Use the last local cache while offline.
    }
  }
  const db = await getDb();
  const items = await db.getAllFromIndex('items', 'boxId', boxId);
  return items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
};

export const listAllItems = async () => {
  if (cloudEnabled()) {
    try {
      return (await getCloudData()).items;
    } catch {
      // Use the last local cache while offline.
    }
  }
  const db = await getDb();
  return db.getAll('items');
};

export const createItem = async (input: {
  boxId: string;
  name: string;
  specModel?: string;
  quantity: number;
  unit?: string;
  imageDataUrl?: string;
  note?: string;
  createdAt?: string;
}) => {
  const db = await getDb();
  const now = input.createdAt || nowIso();
  const item: Item = {
    id: createId(),
    boxId: input.boxId,
    name: input.name.trim(),
    specModel: input.specModel?.trim(),
    quantity: input.quantity,
    unit: input.unit?.trim(),
    imageDataUrl: input.imageDataUrl,
    note: input.note?.trim(),
    createdAt: now,
    updatedAt: now,
  };
  if (cloudEnabled()) return cloudCreateItem(item);

  const tx = db.transaction(['items', 'movements'], 'readwrite');
  await tx.objectStore('items').put(item);
  if (input.quantity > 0) {
    const movement: StockMovement = {
      id: createId(),
      boxId: input.boxId,
      itemId: item.id,
      type: 'in',
      quantity: input.quantity,
      beforeQuantity: 0,
      afterQuantity: input.quantity,
      imageDataUrl: input.imageDataUrl,
      note: '初始库存',
      createdAt: now,
    };
    await tx.objectStore('movements').put(movement);
  }
  await tx.done;
  await touchBox(input.boxId);
  return item;
};

export const updateItem = async (
  item: Item,
  input: { name: string; specModel?: string; quantity: number; unit?: string; imageDataUrl?: string; note?: string },
) => {
  const db = await getDb();
  const now = nowIso();
  const updated: Item = {
    ...item,
    name: input.name.trim(),
    specModel: input.specModel?.trim(),
    quantity: input.quantity,
    unit: input.unit?.trim(),
    imageDataUrl: input.imageDataUrl ?? item.imageDataUrl,
    note: input.note?.trim(),
    updatedAt: now,
  };
  if (cloudEnabled()) return cloudUpdateItem(item.id, updated);
  const tx = db.transaction(['items', 'movements'], 'readwrite');
  await tx.objectStore('items').put(updated);
  if (input.quantity !== item.quantity) {
    const movement: StockMovement = {
      id: createId(),
      boxId: item.boxId,
      itemId: item.id,
      type: 'adjust',
      quantity: Math.abs(input.quantity - item.quantity),
      beforeQuantity: item.quantity,
      afterQuantity: input.quantity,
      note: '手动调整库存',
      createdAt: now,
    };
    await tx.objectStore('movements').put(movement);
  }
  await tx.done;
  await touchBox(item.boxId);
  return updated;
};

export const deleteItem = async (item: Item) => {
  if (cloudEnabled()) {
    await cloudDeleteItem(item.id);
    return;
  }
  const db = await getDb();
  const tx = db.transaction(['items', 'movements'], 'readwrite');
  await tx.objectStore('items').delete(item.id);
  const movements = await tx.objectStore('movements').index('itemId').getAll(item.id);
  await Promise.all(movements.map((movement) => tx.objectStore('movements').delete(movement.id)));
  await tx.done;
  await touchBox(item.boxId);
};

export const changeStock = async (
  item: Item,
  type: 'in' | 'out',
  quantity: number,
  input?: { note?: string; teamName?: string; createdAt?: string; imageDataUrl?: string },
) => {
  if (cloudEnabled()) return cloudChangeStock(item.id, { type, quantity, ...input });
  if (quantity <= 0) throw new Error('数量必须大于 0');
  const afterQuantity = type === 'in' ? item.quantity + quantity : item.quantity - quantity;
  if (afterQuantity < 0) throw new Error('出库数量不能超过当前库存');

  const db = await getDb();
  const now = input?.createdAt || nowIso();
  const updated: Item = {
    ...item,
    quantity: afterQuantity,
    imageDataUrl: type === 'in' && input?.imageDataUrl ? input.imageDataUrl : item.imageDataUrl,
    updatedAt: now,
  };
  const movement: StockMovement = {
    id: createId(),
    boxId: item.boxId,
    itemId: item.id,
    type,
    quantity,
    beforeQuantity: item.quantity,
    afterQuantity,
    teamName: input?.teamName?.trim(),
    imageDataUrl: input?.imageDataUrl,
    note: input?.note?.trim(),
    createdAt: now,
  };

  const tx = db.transaction(['items', 'movements'], 'readwrite');
  await tx.objectStore('items').put(updated);
  await tx.objectStore('movements').put(movement);
  await tx.done;
  await touchBox(item.boxId);
  return updated;
};
