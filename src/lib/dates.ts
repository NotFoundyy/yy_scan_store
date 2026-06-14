export const nowIso = () => new Date().toISOString();

const padTime = (value: number) => String(value).padStart(2, '0');

const dotDate = (date: Date) => `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`;

export const formatDate = (value?: string) => {
  if (!value) return '-';
  const date = new Date(value);
  return `${dotDate(date)} ${padTime(date.getHours())}:${padTime(date.getMinutes())}`;
};

export const formatDateOnly = (value?: string) => {
  if (!value) return '';
  return dotDate(new Date(value));
};

export const toDatetimeLocal = (value = new Date().toISOString()) => {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const fromDatetimeLocal = (value: string) => new Date(value).toISOString();

export const compactDate = (date = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
};

export const compactDateTime = (date = new Date()) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${compactDate(date)}.${pad(date.getHours())}${pad(date.getMinutes())}`;
};
