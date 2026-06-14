import type { Box, Item, SharedBox, StockMovement } from '../types/domain';
import { api } from './api';
import { getSession, setLocalDataOwner } from './auth';
import { clearAccountDatabase, getDb, replaceDatabase } from './db';
import { nowIso } from './dates';

type CloudData = { boxes: Box[]; items: Item[]; movements: StockMovement[] };
let cache: CloudData | undefined;
let pending: Promise<CloudData> | undefined;

export const cloudEnabled = () => Boolean(getSession());
export const invalidateCloudData = () => {
  cache = undefined;
  pending = undefined;
};

export const clearLocalAccountData = async () => {
  invalidateCloudData();
  await clearAccountDatabase();
  setLocalDataOwner(undefined);
};

export const getCloudData = async (force = false) => {
  if (!force && cache) return cache;
  if (force) pending = undefined;
  pending ??= flushSyncQueue().then(() => api.get<CloudData>('/data')).then(async (data) => {
    cache = data;
    await replaceDatabase(data);
    setLocalDataOwner(getSession()?.user.id);
    return data;
  }).finally(() => {
    pending = undefined;
  });
  return pending;
};

export const cloudCreateBox = async (input: Omit<Box, 'shareToken'>) => {
  try {
    const box = await api.post<Box>('/boxes', input);
    invalidateCloudData();
    return box;
  } catch (error) {
    if (!shouldQueue(error)) throw error;
    const db = await getDb();
    await db.put('boxes', input);
    await enqueue('box-create', { input });
    return input;
  }
};
export const cloudUpdateBox = async (id: string, input: Partial<Box>) => {
  try {
    const box = await api.post<Box>(`/boxes/${id}/update`, input);
    invalidateCloudData();
    return box;
  } catch (error) {
    if (!shouldQueue(error)) throw error;
    const db = await getDb();
    const current = await db.get('boxes', id);
    if (!current) throw error;
    const updated = { ...current, ...input, updatedAt: nowIso() };
    await db.put('boxes', updated);
    await enqueue('box-update', { id, input });
    return updated;
  }
};
export const cloudDeleteBox = async (id: string) => {
  try {
    await api.post(`/boxes/${id}/delete`);
    invalidateCloudData();
  } catch (error) {
    if (!shouldQueue(error)) throw error;
    const db = await getDb();
    const tx = db.transaction(['boxes', 'items', 'movements'], 'readwrite');
    const [boxItems, boxMovements] = await Promise.all([
      tx.objectStore('items').index('boxId').getAll(id),
      tx.objectStore('movements').index('boxId').getAll(id),
    ]);
    await Promise.all([
      tx.objectStore('boxes').delete(id),
      ...boxItems.map((item) => tx.objectStore('items').delete(item.id)),
      ...boxMovements.map((movement) => tx.objectStore('movements').delete(movement.id)),
    ]);
    await tx.done;
    await enqueue('box-delete', { id });
  }
};
export const cloudCreateItem = async (input: Item) => {
  try {
    const item = await api.post<Item>('/items', input);
    invalidateCloudData();
    return item;
  } catch (error) {
    if (!shouldQueue(error)) throw error;
    const db = await getDb();
    const tx = db.transaction(['items', 'movements'], 'readwrite');
    await tx.objectStore('items').put(input);
    if (input.quantity > 0) {
      await tx.objectStore('movements').put({
        id: crypto.randomUUID(), boxId: input.boxId, itemId: input.id, type: 'in', quantity: input.quantity,
        beforeQuantity: 0, afterQuantity: input.quantity, note: '离线初始库存', createdAt: input.createdAt,
      });
    }
    await tx.done;
    await enqueue('item-create', { input });
    return input;
  }
};
export const cloudUpdateItem = async (id: string, input: Partial<Item>) => {
  try {
    const item = await api.post<Item>(`/items/${id}/update`, input);
    invalidateCloudData();
    return item;
  } catch (error) {
    if (!shouldQueue(error)) throw error;
    const db = await getDb();
    const current = await db.get('items', id);
    if (!current) throw error;
    const updated = { ...current, ...input, updatedAt: nowIso() };
    await db.put('items', updated);
    await enqueue('item-update', { id, input });
    return updated;
  }
};
export const cloudDeleteItem = async (id: string) => {
  try {
    await api.post(`/items/${id}/delete`);
    invalidateCloudData();
  } catch (error) {
    if (!shouldQueue(error)) throw error;
    const db = await getDb();
    const tx = db.transaction(['items', 'movements'], 'readwrite');
    const itemMovements = await tx.objectStore('movements').index('itemId').getAll(id);
    await Promise.all([
      tx.objectStore('items').delete(id),
      ...itemMovements.map((movement) => tx.objectStore('movements').delete(movement.id)),
    ]);
    await tx.done;
    await enqueue('item-delete', { id });
  }
};
export const cloudChangeStock = async (
  itemId: string,
  input: { type: 'in' | 'out'; quantity: number; teamName?: string; note?: string; imageDataUrl?: string; createdAt?: string },
) => {
  const operation = {
    ...input,
    operationId: crypto.randomUUID(),
  };
  try {
    const result = await api.post<{ item: Item; movementId: string }>(`/items/${itemId}/movements`, operation);
    invalidateCloudData();
    return result.item;
  } catch (error) {
    if (!shouldQueue(error)) throw error;
    const db = await getDb();
    const item = await db.get('items', itemId);
    if (!item) throw error;
    const afterQuantity = input.type === 'in' ? item.quantity + input.quantity : item.quantity - input.quantity;
    if (afterQuantity < 0) throw new Error('出库数量不能超过当前库存');
    const createdAt = input.createdAt || nowIso();
    const updated = { ...item, quantity: afterQuantity, updatedAt: createdAt };
    const tx = db.transaction(['items', 'movements', 'syncQueue'], 'readwrite');
    await tx.objectStore('items').put(updated);
    await tx.objectStore('movements').put({
      id: operation.operationId,
      boxId: item.boxId,
      itemId,
      type: input.type,
      quantity: input.quantity,
      beforeQuantity: item.quantity,
      afterQuantity,
      teamName: input.teamName,
      note: input.note,
      imageDataUrl: input.imageDataUrl,
      createdAt,
    });
    await tx.objectStore('syncQueue').put({
      id: operation.operationId,
      type: 'stock-change',
      payload: { itemId, operation },
      createdAt,
      attempts: 0,
    });
    await tx.done;
    invalidateCloudData();
    return updated;
  }
};
export const getSharedBox = (boxId: string, token: string) =>
  api.get<SharedBox>(`/shared/boxes/${encodeURIComponent(boxId)}?token=${encodeURIComponent(token)}`);

export const cloudImportSnapshot = async (data: CloudData) => {
  const result = await api.post<{ boxes: number; items: number }>('/import', data);
  invalidateCloudData();
  await getCloudData(true);
  return result;
};

export const cloudRestoreSnapshot = async (data: CloudData) => {
  const result = await api.post<{ boxes: number; items: number }>('/restore', data);
  invalidateCloudData();
  await getCloudData(true);
  return result;
};

export const cloudUpdateMovement = async (
  id: string,
  input: { quantity: number; teamName?: string; note?: string; createdAt: string; imageDataUrl?: string },
) => {
  await api.post(`/movements/${id}/update`, input);
  invalidateCloudData();
  await getCloudData(true);
};

export const cloudExcludeMovements = async (boxId: string, teamNames: string[]) => {
  const result = await api.post<{ count: number }>(`/boxes/${boxId}/movements/exclude`, { teamNames });
  invalidateCloudData();
  await getCloudData(true);
  return result.count;
};

export const createShareQrValue = (box: Box) =>
  box.shareToken ? `storescan:v1:box:${box.id}:${box.shareToken}` : box.code;

export const parseShareQrValue = (value: string) => {
  const match = value.trim().match(/^storescan:v1:box:([0-9a-f-]{36}):([A-Za-z0-9_-]+)$/i);
  return match ? { boxId: match[1]!, token: match[2]! } : undefined;
};

export const flushSyncQueue = async () => {
  if (!getSession() || !navigator.onLine) return;
  const db = await getDb();
  const queued = await db.getAll('syncQueue');
  for (const entry of queued.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    try {
      const payload = entry.payload as Record<string, any>;
      if (entry.type === 'stock-change') await api.post(`/items/${payload.itemId}/movements`, payload.operation);
      else if (entry.type === 'box-create') await api.post('/boxes', payload.input);
      else if (entry.type === 'box-update') await api.post(`/boxes/${payload.id}/update`, payload.input);
      else if (entry.type === 'box-delete') await api.post(`/boxes/${payload.id}/delete`);
      else if (entry.type === 'item-create') await api.post('/items', payload.input);
      else if (entry.type === 'item-update') await api.post(`/items/${payload.id}/update`, payload.input);
      else if (entry.type === 'item-delete') await api.post(`/items/${payload.id}/delete`);
      else continue;
      await db.delete('syncQueue', entry.id);
    } catch (error) {
      const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 0;
      if (status >= 400 && status < 500) {
        await db.put('syncConflicts', {
          id: entry.id,
          type: entry.type,
          payload: entry.payload,
          reason: error instanceof Error ? error.message : '库存冲突',
          createdAt: nowIso(),
        });
        await db.delete('syncQueue', entry.id);
        continue;
      }
      await db.put('syncQueue', { ...entry, attempts: entry.attempts + 1 });
      break;
    }
  }
};

const shouldQueue = (error: unknown) => {
  if (!navigator.onLine) return true;
  const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 0;
  return status === 0 || status >= 500;
};

const enqueue = async (type: string, payload: unknown) => {
  const db = await getDb();
  await db.put('syncQueue', {
    id: crypto.randomUUID(),
    type,
    payload,
    createdAt: nowIso(),
    attempts: 0,
  });
};

export const getSyncStatus = async () => {
  const db = await getDb();
  const [queued, conflicts] = await Promise.all([db.count('syncQueue'), db.count('syncConflicts')]);
  return { queued, conflicts };
};
