import type { Box, Item, StockMovement } from '../types/domain';
import type { ImportBoxRow } from '../lib/importBoxesExcel';
import { getDb } from '../lib/db';
import { nowIso } from '../lib/dates';
import { createBoxCode, createId } from '../lib/ids';
import { cloudEnabled, cloudImportSnapshot, getCloudData } from '../lib/cloud';

export const importBoxesWithItems = async (rows: ImportBoxRow[]) => {
  const db = await getDb();
  const existingBoxes = cloudEnabled() ? (await getCloudData()).boxes : await db.getAll('boxes');
  const knownNames = new Set(existingBoxes.map((box) => box.name.trim()));
  const knownCodes = new Set(existingBoxes.map((box) => box.code.trim()));
  const allBoxesForCode: Box[] = [...existingBoxes];
  const boxes: Box[] = [];
  const items: Item[] = [];
  const movements: StockMovement[] = [];
  const skippedBoxes: string[] = [];
  const now = nowIso();

  rows.forEach((row) => {
    const name = row.name.trim();
    const requestedCode = row.code?.trim();
    if (!name || knownNames.has(name) || (requestedCode && knownCodes.has(requestedCode))) {
      skippedBoxes.push(name || requestedCode || '未命名箱子');
      return;
    }

    const box: Box = {
      id: createId(),
      code: requestedCode || createBoxCode(allBoxesForCode),
      name,
      note: 'Excel 导入',
      createdAt: now,
      updatedAt: now,
    };
    knownNames.add(box.name);
    knownCodes.add(box.code);
    allBoxesForCode.push(box);
    boxes.push(box);

    row.items.forEach((entry) => {
      const createdAt = entry.createdAt || now;
      const item: Item = {
        id: createId(),
        boxId: box.id,
        name: entry.name.trim(),
        specModel: entry.specModel?.trim(),
        quantity: entry.quantity,
        unit: entry.unit?.trim(),
        note: entry.note?.trim(),
        createdAt,
        updatedAt: createdAt,
      };
      items.push(item);
      if (item.quantity > 0) {
        movements.push({
          id: createId(),
          boxId: box.id,
          itemId: item.id,
          type: 'in',
          quantity: item.quantity,
          beforeQuantity: 0,
          afterQuantity: item.quantity,
          note: 'Excel 导入初始库存',
          createdAt,
        });
      }
    });
  });

  if (cloudEnabled()) {
    await cloudImportSnapshot({ boxes, items, movements });
    return {
      importedBoxes: boxes.length,
      importedItems: items.length,
      importedMovements: movements.length,
      skippedBoxes,
    };
  }

  const tx = db.transaction(['boxes', 'items', 'movements'], 'readwrite');
  await Promise.all([
    ...boxes.map((box) => tx.objectStore('boxes').put(box)),
    ...items.map((item) => tx.objectStore('items').put(item)),
    ...movements.map((movement) => tx.objectStore('movements').put(movement)),
  ]);
  await tx.done;

  return {
    importedBoxes: boxes.length,
    importedItems: items.length,
    importedMovements: movements.length,
    skippedBoxes,
  };
};
