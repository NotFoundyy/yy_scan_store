import type { BackupFile, Box, Item, StockMovement } from '../types/domain';
import { compactDateTime } from './dates';
import { replaceDatabase } from './db';
import { cloudEnabled, cloudRestoreSnapshot } from './cloud';
import { isNativeApp, shareTextFile } from './nativeFiles';

export const exportBackup = async (data: { boxes: Box[]; items: Item[]; movements: StockMovement[] }) => {
  const backup: BackupFile = {
    app: 'store-scan',
    version: 1,
    exportedAt: new Date().toISOString(),
    boxes: data.boxes,
    items: data.items,
    movements: data.movements,
  };
  const text = JSON.stringify(backup, null, 2);
  const fileName = `store-scan-backup-${compactDateTime()}.json`;
  if (isNativeApp()) {
    await shareTextFile({ text, fileName, title: '仓库数据备份', dialogTitle: '保存或分享备份文件' });
    return;
  }
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
};

export const parseBackupFile = async (file: File) => {
  const text = await file.text();
  const parsed = JSON.parse(text) as BackupFile;
  if (parsed.app !== 'store-scan' || !Array.isArray(parsed.boxes) || !Array.isArray(parsed.items)) {
    throw new Error('备份文件格式不正确');
  }
  if (!Array.isArray(parsed.movements)) parsed.movements = [];
  return parsed;
};

export const restoreBackup = async (backup: BackupFile) => {
  if (cloudEnabled()) {
    await cloudRestoreSnapshot(backup);
    return;
  }
  await replaceDatabase({
    boxes: backup.boxes,
    items: backup.items,
    movements: backup.movements,
  });
};
