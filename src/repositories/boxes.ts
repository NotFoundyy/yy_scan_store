import type { Box } from '../types/domain';
import { getDb } from '../lib/db';
import { nowIso } from '../lib/dates';
import { createBoxCode, createId } from '../lib/ids';
import { cloudCreateBox, cloudDeleteBox, cloudEnabled, cloudUpdateBox, getCloudData } from '../lib/cloud';

export const listBoxes = async (includeArchived = false) => {
  if (cloudEnabled()) {
    try {
      const data = await getCloudData();
      return data.boxes.filter((box) => includeArchived || !box.archived);
    } catch {
      // Use the last local cache while offline.
    }
  }
  const db = await getDb();
  const boxes = await db.getAll('boxes');
  return boxes
    .filter((box) => includeArchived || !box.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const getBox = async (id: string) => {
  const db = await getDb();
  return db.get('boxes', id);
};

export const getBoxByCode = async (code: string) => {
  if (cloudEnabled()) {
    try {
      return (await getCloudData()).boxes.find((box) => box.code === code.trim() && !box.archived);
    } catch {
      // Use the last local cache while offline.
    }
  }
  const db = await getDb();
  const box = await db.getFromIndex('boxes', 'code', code.trim());
  return box && !box.archived ? box : undefined;
};

export const createBox = async (input: { name: string; note?: string; imageDataUrl?: string }) => {
  const db = await getDb();
  const allBoxes = await db.getAll('boxes');
  const now = nowIso();
  const box: Box = {
    id: createId(),
    code: createBoxCode(allBoxes),
    name: input.name.trim(),
    note: input.note?.trim(),
    imageDataUrl: input.imageDataUrl,
    createdAt: now,
    updatedAt: now,
  };
  if (cloudEnabled()) return cloudCreateBox(box);
  await db.put('boxes', box);
  return box;
};

export const updateBox = async (box: Box, input: { name: string; note?: string; imageDataUrl?: string }) => {
  const db = await getDb();
  const updated: Box = {
    ...box,
    name: input.name.trim(),
    note: input.note?.trim(),
    imageDataUrl: input.imageDataUrl,
    updatedAt: nowIso(),
  };
  if (cloudEnabled()) return cloudUpdateBox(box.id, updated);
  await db.put('boxes', updated);
  return updated;
};

export const archiveBox = async (box: Box) => {
  if (cloudEnabled()) {
    await cloudUpdateBox(box.id, { archived: true });
    return;
  }
  const db = await getDb();
  await db.put('boxes', { ...box, archived: true, updatedAt: nowIso() });
};

export const deleteBox = async (box: Box) => {
  if (cloudEnabled()) {
    await cloudDeleteBox(box.id);
    return;
  }
  const db = await getDb();
  const tx = db.transaction(['boxes', 'items', 'movements'], 'readwrite');
  const [items, movements] = await Promise.all([
    tx.objectStore('items').index('boxId').getAll(box.id),
    tx.objectStore('movements').index('boxId').getAll(box.id),
  ]);
  await Promise.all([
    tx.objectStore('boxes').delete(box.id),
    ...items.map((item) => tx.objectStore('items').delete(item.id)),
    ...movements.map((movement) => tx.objectStore('movements').delete(movement.id)),
  ]);
  await tx.done;
};

export const touchBox = async (boxId: string) => {
  const db = await getDb();
  const box = await db.get('boxes', boxId);
  if (box) await db.put('boxes', { ...box, updatedAt: nowIso() });
};
