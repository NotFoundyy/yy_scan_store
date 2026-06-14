import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Box, Item, StockMovement } from '../types/domain';

interface StoreScanDb extends DBSchema {
  boxes: {
    key: string;
    value: Box;
    indexes: { code: string; updatedAt: string };
  };
  items: {
    key: string;
    value: Item;
    indexes: { boxId: string; updatedAt: string };
  };
  movements: {
    key: string;
    value: StockMovement;
    indexes: { boxId: string; itemId: string; createdAt: string };
  };
  meta: {
    key: string;
    value: unknown;
  };
  syncQueue: {
    key: string;
    value: { id: string; type: string; payload: unknown; createdAt: string; attempts: number };
  };
  syncConflicts: {
    key: string;
    value: { id: string; type: string; payload: unknown; reason: string; createdAt: string };
  };
}

let dbPromise: Promise<IDBPDatabase<StoreScanDb>> | undefined;

export const getDb = () => {
  dbPromise ??= openDB<StoreScanDb>('store-scan-db', 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const boxes = db.createObjectStore('boxes', { keyPath: 'id' });
        boxes.createIndex('code', 'code', { unique: true });
        boxes.createIndex('updatedAt', 'updatedAt');

        const items = db.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('boxId', 'boxId');
        items.createIndex('updatedAt', 'updatedAt');

        const movements = db.createObjectStore('movements', { keyPath: 'id' });
        movements.createIndex('boxId', 'boxId');
        movements.createIndex('itemId', 'itemId');
        movements.createIndex('createdAt', 'createdAt');

        db.createObjectStore('meta');
      }
      if (oldVersion < 2) {
        db.createObjectStore('syncQueue', { keyPath: 'id' });
        db.createObjectStore('syncConflicts', { keyPath: 'id' });
      }
    },
  });

  return dbPromise;
};

export const getDatabaseSnapshot = async () => {
  const db = await getDb();
  const [boxes, items, movements] = await Promise.all([
    db.getAll('boxes'),
    db.getAll('items'),
    db.getAll('movements'),
  ]);
  return { boxes, items, movements };
};

export const replaceDatabase = async (data: {
  boxes: Box[];
  items: Item[];
  movements: StockMovement[];
}) => {
  const db = await getDb();
  const tx = db.transaction(['boxes', 'items', 'movements'], 'readwrite');
  await Promise.all([
    tx.objectStore('boxes').clear(),
    tx.objectStore('items').clear(),
    tx.objectStore('movements').clear(),
  ]);
  await Promise.all([
    ...data.boxes.map((box) => tx.objectStore('boxes').put(box)),
    ...data.items.map((item) => tx.objectStore('items').put(item)),
    ...data.movements.map((movement) => tx.objectStore('movements').put(movement)),
  ]);
  await tx.done;
};
