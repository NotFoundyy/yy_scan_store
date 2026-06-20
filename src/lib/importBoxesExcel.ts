import * as XLSX from 'xlsx-js-style';

export type ImportBoxRow = {
  name: string;
  code?: string;
  items: Array<{
    name: string;
    specModel?: string;
    quantity: number;
    unit?: string;
    createdAt?: string;
    note?: string;
  }>;
};

const readCell = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
};

const parseDateCell = (value: string) => {
  if (!value) return undefined;
  const normalized = value.replace(/\./g, '-').replace(/\//g, '-');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export const parseBoxesExcel = async (file: File): Promise<ImportBoxRow[]> => {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const grouped = new Map<string, ImportBoxRow>();

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    rows.forEach((row) => {
      const boxName = readCell(row, ['箱子名称', '箱子', '箱名']) || sheetName;
      if (!boxName) return;

      const code = readCell(row, ['箱子编码', '箱码', '编码']);
      const key = code || boxName;
      if (!grouped.has(key)) grouped.set(key, { name: boxName, code, items: [] });

      const itemName = readCell(row, ['物品类型', '物品名称', '物品']);
      if (!itemName) return;

      const quantity = Number(readCell(row, ['数量', '入库数量', '库存']));
      grouped.get(key)!.items.push({
        name: itemName,
        specModel: readCell(row, ['规格型号', '规格']),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 0,
        unit: readCell(row, ['单位']),
        createdAt: parseDateCell(readCell(row, ['入库时间', '入库日期', '时间'])),
        note: readCell(row, ['备注']),
      });
    });
  });

  return Array.from(grouped.values());
};
