import type { Box } from '../types/domain';
export const createId = () => {
  if ('randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export const createBoxCode = (boxes: Box[]) => {
  const prefix = 'YCK-';
  const max = boxes
    .map((box) => box.code)
    .filter((code) => code.startsWith(prefix))
    .map((code) => Number(code.slice(prefix.length)))
    .filter((value) => Number.isFinite(value))
    .reduce((current, value) => Math.max(current, value), 0);

  return `${prefix}${String(max + 1).padStart(3, '0')}`;
};

export const displayBoxCode = (code: string) => code.replace(/^BOX-\d{8}-(\d+)$/, 'BOX-$1');
