import * as XLSX from 'xlsx-js-style';
import type { Box, Item, StockMovement } from '../types/domain';
import { compactDateTime, formatDateOnly } from './dates';
import { compareBoxCodes } from './ids';
import { isNativeApp, shareBase64File } from './nativeFiles';

const invalidFileChars = /[<>:"/\\|?*\u0000-\u001f]/g;
const invalidSheetChars = /[:\\/?*\[\]]/g;

export const defaultExportFileName = (name = '物品') => `${name}出入库明细表-${compactDateTime()}.xlsx`;
export const defaultMovementExportFileName = (name = '流水') => `${name}记录-${compactDateTime()}.xlsx`;

export const normalizeExcelFileName = (name: string) => {
  const cleaned = name.replace(invalidFileChars, '').trim();
  const safe = cleaned || defaultExportFileName();
  return safe.toLowerCase().endsWith('.xlsx') ? safe : `${safe}.xlsx`;
};

const sheetName = (name: string, used: Set<string>) => {
  const base = (name.replace(invalidSheetChars, '').trim() || '未命名箱子').slice(0, 25);
  let candidate = base;
  let index = 1;
  while (used.has(candidate)) {
    const suffix = `-${String(index).padStart(4, '0')}`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
};

const unitQuantity = (quantity?: number, unit?: string) => {
  if (!quantity) return '';
  return `${quantity}${unit ?? ''}`;
};

const getItem = (items: Item[], itemId: string) => items.find((item) => item.id === itemId);

const isExportVisibleMovement = (movement: StockMovement) => !(movement.type === 'out' && movement.exportExcluded);

const itemExportCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
});

const compareSpecifications = (a: string, b: string) => {
  const aNumbers = Array.from(a.matchAll(/\d+(?:\.\d+)?/g), (match) => Number(match[0]));
  const bNumbers = Array.from(b.matchAll(/\d+(?:\.\d+)?/g), (match) => Number(match[0]));
  const numberCount = Math.max(aNumbers.length, bNumbers.length);

  for (let index = 0; index < numberCount; index += 1) {
    if (aNumbers[index] === undefined) return 1;
    if (bNumbers[index] === undefined) return -1;
    if (aNumbers[index] !== bNumbers[index]) return aNumbers[index] - bNumbers[index];
  }

  return itemExportCollator.compare(a, b);
};

const compareItemsForExport = (a: Item, b: Item) => {
  const typeOrder = itemExportCollator.compare(a.name.trim(), b.name.trim());
  if (typeOrder !== 0) return typeOrder;

  const aSpec = a.specModel?.trim() ?? '';
  const bSpec = b.specModel?.trim() ?? '';
  if (!aSpec && bSpec) return 1;
  if (aSpec && !bSpec) return -1;

  return compareSpecifications(aSpec, bSpec) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
};

const formatOutCell = (movement: StockMovement, item?: Item) =>
  [formatDateOnly(movement.createdAt), unitQuantity(movement.quantity, item?.unit)]
    .filter(Boolean)
    .join(' ');

const groupOutCellsByTeam = (item: Item, movements: StockMovement[]) => {
  const groups = new Map<string, string[]>();
  movements
    .filter((movement) => movement.itemId === item.id && movement.type === 'out' && isExportVisibleMovement(movement))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .forEach((movement) => {
      const team = movement.teamName?.trim() || '未填班组';
      const rows = groups.get(team) ?? [];
      rows.push(formatOutCell(movement, item));
      groups.set(team, rows);
    });
  return Array.from(groups, ([team, rows]) => `${team}\n${rows.join('\n')}`);
};

const itemInboundSummary = (item: Item, movements: StockMovement[]) => {
  const inbound = movements
    .filter((movement) => movement.itemId === item.id && (movement.type === 'in' || movement.type === 'adjust'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const total = inbound.reduce((sum, movement) => sum + movement.quantity, 0);
  return {
    quantity: total > 0 ? total : item.quantity,
    time: inbound[0]?.createdAt ?? item.createdAt,
  };
};

const boxOutColumnCount = (items: Item[], movements: StockMovement[]) =>
  Math.max(
    1,
    ...items.map((item) => groupOutCellsByTeam(item, movements).length),
  );

const buildDetailRows = (box: Box, items: Item[], movements: StockMovement[], outColumnCount: number) => {
  const boxItems = items.filter((item) => item.boxId === box.id).sort(compareItemsForExport);
  return boxItems.map((item, index) => {
    const inbound = itemInboundSummary(item, movements);
    const outCells = groupOutCellsByTeam(item, movements);
    return [
      index + 1,
      item.name,
      item.specModel ?? '',
      unitQuantity(inbound.quantity, item.unit),
      formatDateOnly(inbound.time),
      ...Array.from({ length: outColumnCount }, (_, outIndex) => outCells[outIndex] ?? ''),
      unitQuantity(item.quantity, item.unit),
      item.note ?? '',
    ];
  });
};

const thinBlack = { style: 'thin', color: { rgb: '000000' } };
const mediumBlack = { style: 'medium', color: { rgb: '000000' } };

const baseBorder = {
  top: thinBlack,
  bottom: thinBlack,
  left: thinBlack,
  right: thinBlack,
};

const ensureCell = (worksheet: XLSX.WorkSheet, row: number, col: number) => {
  const cellRef = XLSX.utils.encode_cell({ r: row, c: col });
  worksheet[cellRef] ??= { t: 's', v: '' };
  return worksheet[cellRef];
};

const charWidth = (str: string) =>
  Array.from(str).reduce((w, ch) => w + (/[一-鿿　-ヿ＀-￯]/.test(ch) ? 2 : 1), 0);

const estimateColumnWidth = (values: unknown[], min: number, max: number) => {
  const longest = values.reduce<number>((w, value) => {
    const lines = String(value ?? '').split('\n');
    return Math.max(w, ...lines.map(charWidth));
  }, 0);
  return Math.min(max, Math.max(min, Math.ceil(longest * 1.1)));
};

const applySheetLayout = (worksheet: XLSX.WorkSheet, rowCount: number, outColumnCount: number, data: unknown[][]) => {
  const footerRow = rowCount + 2;
  const stockCol = 5 + outColumnCount;
  const noteCol = stockCol + 1;
  worksheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: noteCol } },
    { s: { r: 1, c: 5 }, e: { r: 1, c: stockCol - 1 } },
    { s: { r: footerRow, c: 0 }, e: { r: footerRow, c: 2 } },
    { s: { r: footerRow, c: 5 }, e: { r: footerRow, c: Math.min(noteCol, 8) } },
  ];
  worksheet['!cols'] = Array.from({ length: noteCol + 1 }, (_, col) => {
    const values = data.map((row) => row[col]);
    if (col === 0) return { wch: 7 };
    if (col === 1) return { wch: estimateColumnWidth(values, 14, 24) };
    if (col === 2) return { wch: estimateColumnWidth(values, 14, 26) };
    if (col === 3) return { wch: 11 };
    if (col === 4) return { wch: 13 };
    if (col >= 5 && col < stockCol) return { wch: estimateColumnWidth(values, 12, 18) };
    if (col === stockCol) return { wch: 12 };
    return { wch: estimateColumnWidth(values, 12, 36) };
  });
  worksheet['!rows'] = [
    { hpt: 28 },
    { hpt: 42 },
    ...Array.from({ length: rowCount }, (_, index) => {
      const row = data[index + 2] ?? [];
      const maxLines = row.reduce<number>((count, value) => Math.max(count, String(value ?? '').split('\n').length), 1);
      return { hpt: Math.max(24, maxLines * 18) };
    }),
    { hpt: 24 },
  ];

  const range = XLSX.utils.decode_range(worksheet['!ref'] ?? 'A1:A1');
  range.e.c = Math.max(range.e.c, noteCol);
  range.e.r = Math.max(range.e.r, footerRow);
  worksheet['!ref'] = XLSX.utils.encode_range(range);

  for (let row = 0; row <= footerRow; row += 1) {
    for (let col = 0; col <= noteCol; col += 1) {
      const cell = ensureCell(worksheet, row, col);
      const isTitle = row === 0;
      const isHeader = row === 1;
      const isFooter = row === footerRow;
      const isOuterTop = row === 0;
      const isOuterBottom = row === footerRow;
      const isOuterLeft = col === 0;
      const isOuterRight = col === noteCol;

      cell.s = {
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        font: {
          name: '宋体',
          sz: isTitle ? 16 : 11,
          bold: isTitle || isHeader,
        },
        fill: isHeader ? { fgColor: { rgb: 'F2F2F2' } } : undefined,
        border: {
          ...baseBorder,
          top: isOuterTop ? mediumBlack : thinBlack,
          bottom: isOuterBottom || isHeader ? mediumBlack : thinBlack,
          left: isOuterLeft ? mediumBlack : thinBlack,
          right: isOuterRight ? mediumBlack : thinBlack,
        },
      };

      if (isFooter) {
        cell.s.alignment = { horizontal: 'left', vertical: 'center', wrapText: true };
        cell.s.font = { name: '宋体', sz: 11, bold: true };
      }
    }
  }
};

const buildBoxSheet = (box: Box, items: Item[], movements: StockMovement[]) => {
  const boxItems = items.filter((item) => item.boxId === box.id);
  const outColumnCount = boxOutColumnCount(boxItems, movements);
  const rows = buildDetailRows(box, boxItems, movements, outColumnCount);
  const minRows = Math.max(20, rows.length);
  const rowWidth = 5 + outColumnCount + 2;
  const blankRows = Array.from({ length: minRows - rows.length }, (_, index) => [
    rows.length + index + 1,
    ...Array.from({ length: rowWidth - 1 }, () => ''),
  ]);
  const data = [
    ['硅钢作业区物品出入库明细表', ...Array.from({ length: rowWidth - 1 }, () => '')],
    [
      '序号',
      '物品类型',
      '规格型号',
      '入库数量',
      '入库时间',
      '领取班组时间及数量',
      ...Array.from({ length: outColumnCount - 1 }, () => ''),
      '库存结余',
      '备注',
    ],
    ...rows,
    ...blankRows,
    [
      `负责人：`,
      '',
      '',
      '',
      '',
      '工具箱编号：',
      box.code,
      ...Array.from({ length: Math.max(0, rowWidth - 7) }, () => ''),
    ],
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(data);
  applySheetLayout(worksheet, minRows, outColumnCount, data);
  return worksheet;
};

const movementTypeLabel = (type: StockMovement['type']) => (type === 'out' ? '出库' : type === 'in' ? '入库' : '调整');

const buildSummarySheet = (boxes: Box[], items: Item[], movements: StockMovement[]) => {
  const headers = ['序号', '时间', '类型', '箱子名称', '箱子编码', '物品类型', '规格型号', '数量', '单位', '班组', '库存结余', '备注'];
  const visibleMovements = movements.filter(isExportVisibleMovement);
  const rows = visibleMovements.map((movement, index) => {
    const box = boxes.find((entry) => entry.id === movement.boxId);
    const item = getItem(items, movement.itemId);
    return [
      index + 1,
      formatDateOnly(movement.createdAt),
      movementTypeLabel(movement.type),
      box?.name ?? '未知箱子',
      box?.code ?? '',
      item?.name ?? '已删除物品',
      item?.specModel ?? '',
      movement.quantity,
      item?.unit ?? '',
      movement.teamName ?? '',
      movement.afterQuantity,
      movement.note ?? '',
    ];
  });
  const data = [
    ['全部箱子流水汇总', ...Array.from({ length: headers.length - 1 }, () => '')],
    [`共 ${visibleMovements.length} 条记录`, ...Array.from({ length: headers.length - 1 }, () => '')],
    headers,
    ...rows,
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(data);
  worksheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: headers.length - 1 } },
  ];
  worksheet['!freeze'] = { xSplit: 0, ySplit: 3 };
  worksheet['!cols'] = [
    { wch: 7 },
    { wch: 18 },
    { wch: 9 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 10 },
    { wch: 8 },
    { wch: 12 },
    { wch: 12 },
    { wch: 24 },
  ];
  worksheet['!rows'] = [{ hpt: 30 }, { hpt: 24 }, { hpt: 26 }, ...Array.from({ length: rows.length }, () => ({ hpt: 22 }))];

  const range = XLSX.utils.decode_range(worksheet['!ref'] ?? 'A1:A1');
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const cell = ensureCell(worksheet, row, col);
      const isTitle = row === 0;
      const isSubtitle = row === 1;
      const isHeader = row === 2;
      cell.s = {
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        font: {
          name: 'Microsoft YaHei',
          sz: isTitle ? 16 : 11,
          bold: isTitle || isHeader,
          color: { rgb: isSubtitle ? '667085' : '1D1D1F' },
        },
        fill: isHeader ? { fgColor: { rgb: 'E6F4FF' } } : undefined,
        border: isTitle || isSubtitle ? undefined : baseBorder,
      };
    }
  }
  return worksheet;
};

const buildMovementSheet = (
  boxes: Box[],
  items: Item[],
  movements: StockMovement[],
  filterSummary?: { fromDate?: string; toDate?: string; boxName?: string; teamName?: string },
) => {
  const filters = [
    filterSummary?.fromDate ? `开始：${filterSummary.fromDate}` : '',
    filterSummary?.toDate ? `结束：${filterSummary.toDate}` : '',
    filterSummary?.boxName ? `箱子：${filterSummary.boxName}` : '',
    filterSummary?.teamName ? `班组：${filterSummary.teamName}` : '',
  ].filter(Boolean);
  const headers = ['序号', '时间', '类型', '箱子名称', '箱子编码', '物品类型', '规格型号', '数量', '单位', '班组', '库存结余', '备注'];
  const visibleMovements = movements.filter(isExportVisibleMovement);
  const rows = visibleMovements.map((movement, index) => {
    const box = boxes.find((entry) => entry.id === movement.boxId);
    const item = getItem(items, movement.itemId);
    return [
      index + 1,
      formatDateOnly(movement.createdAt),
      movementTypeLabel(movement.type),
      box?.name ?? '未知箱子',
      box?.code ?? '',
      item?.name ?? '已删除物品',
      item?.specModel ?? '',
      movement.quantity,
      item?.unit ?? '',
      movement.teamName ?? '',
      movement.afterQuantity,
      movement.note ?? '',
    ];
  });
  const data = [
    ['出入库流水记录', ...Array.from({ length: headers.length - 1 }, () => '')],
    [filters.length ? filters.join('    ') : '筛选：全部记录', ...Array.from({ length: headers.length - 1 }, () => '')],
    headers,
    ...rows,
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(data);
  worksheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: headers.length - 1 } },
  ];
  worksheet['!freeze'] = { xSplit: 0, ySplit: 3 };
  worksheet['!cols'] = [
    { wch: 7 },
    { wch: 18 },
    { wch: 9 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 10 },
    { wch: 8 },
    { wch: 12 },
    { wch: 12 },
    { wch: 24 },
  ];
  worksheet['!rows'] = [{ hpt: 30 }, { hpt: 24 }, { hpt: 26 }, ...Array.from({ length: rows.length }, () => ({ hpt: 22 }))];

  const range = XLSX.utils.decode_range(worksheet['!ref'] ?? 'A1:A1');
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const cell = ensureCell(worksheet, row, col);
      const isTitle = row === 0;
      const isFilter = row === 1;
      const isHeader = row === 2;
      cell.s = {
        alignment: {
          horizontal: isFilter || col === 11 ? 'left' : 'center',
          vertical: 'center',
          wrapText: true,
        },
        font: {
          name: 'Microsoft YaHei',
          sz: isTitle ? 16 : 11,
          bold: isTitle || isHeader,
          color: { rgb: isFilter ? '667085' : '1D1D1F' },
        },
        fill: isHeader ? { fgColor: { rgb: 'E6F4FF' } } : undefined,
        border: isTitle || isFilter ? undefined : baseBorder,
      };
    }
  }
  return worksheet;
};

type ExportResult = {
  fileName: string;
  method: 'native-share' | 'web-share' | 'download' | 'cancelled';
};

type FileShareData = ShareData & { files?: File[] };

const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const isCancelError = (error: unknown) =>
  (error instanceof DOMException && error.name === 'AbortError') ||
  (error instanceof Error && /cancel/i.test(error.message));

const saveWorkbook = async (workbook: XLSX.WorkBook, requestedFileName: string): Promise<ExportResult> => {
  const fileName = normalizeExcelFileName(requestedFileName);
  const nav = navigator as Navigator & {
    canShare?: (data: FileShareData) => boolean;
    share?: (data: FileShareData) => Promise<void>;
  };

  if (isNativeApp()) {
    const base64 = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64', cellStyles: true }) as string;
    try {
      await shareBase64File({
        base64,
        fileName,
        title: fileName,
        text: '导出的出入库明细表',
        dialogTitle: '保存或分享 Excel',
      });
    } catch (error) {
      if (isCancelError(error)) return { fileName, method: 'cancelled' };
      throw error;
    }
    return { fileName, method: 'native-share' };
  }

  const arrayBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', cellStyles: true }) as ArrayBuffer;
  const blob = new Blob([arrayBuffer], { type: mimeType });
  const file = new File([blob], fileName, { type: mimeType });
  const shareData: FileShareData = { files: [file], title: fileName, text: '导出的出入库明细表' };

  if (nav.share && nav.canShare?.(shareData)) {
    try {
      await nav.share(shareData);
      return { fileName, method: 'web-share' };
    } catch (error) {
      if (isCancelError(error)) return { fileName, method: 'cancelled' };
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { fileName, method: 'download' };
};

export const exportExcel = async (input: {
  boxes: Box[];
  items: Item[];
  movements: StockMovement[];
  selectedBoxIds: string[];
  fileName: string;
  allSelected: boolean;
}): Promise<ExportResult> => {
  const selectedBoxes = input.boxes
    .filter((box) => input.selectedBoxIds.includes(box.id))
    .sort((a, b) => compareBoxCodes(a.code, b.code));
  const workbook = XLSX.utils.book_new();
  const usedNames = new Set<string>();

  selectedBoxes.forEach((box) => {
    XLSX.utils.book_append_sheet(
      workbook,
      buildBoxSheet(box, input.items.filter((item) => item.boxId === box.id), input.movements),
      sheetName(box.name, usedNames),
    );
  });

  if (input.allSelected && selectedBoxes.length > 1) {
    XLSX.utils.book_append_sheet(
      workbook,
      buildSummarySheet(selectedBoxes, input.items, input.movements.filter((movement) => input.selectedBoxIds.includes(movement.boxId))),
      '全部流水汇总',
    );
  }

  return saveWorkbook(workbook, input.fileName);
};

export const exportMovementsExcel = async (input: {
  boxes: Box[];
  items: Item[];
  movements: StockMovement[];
  fileName: string;
  filterSummary?: { fromDate?: string; toDate?: string; boxName?: string; teamName?: string };
}): Promise<ExportResult> => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    buildMovementSheet(input.boxes, input.items, input.movements, input.filterSummary),
    '流水记录',
  );
  return saveWorkbook(workbook, input.fileName);
};
