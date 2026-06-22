export type MovementType = 'in' | 'out' | 'adjust';

export type Box = {
  id: string;
  name: string;
  code: string;
  shareToken?: string;
  note?: string;
  imageDataUrl?: string;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
};

export type SharedBox = {
  box: Pick<Box, 'id' | 'name' | 'code' | 'imageDataUrl' | 'updatedAt'>;
  items: Array<Pick<Item, 'id' | 'boxId' | 'name' | 'specModel' | 'quantity' | 'unit' | 'imageDataUrl' | 'updatedAt'>>;
};

export type Item = {
  id: string;
  boxId: string;
  /** 物品类型，旧版本里叫 name，保留 name 字段以兼容已有数据。 */
  name: string;
  specModel?: string;
  quantity: number;
  unit?: string;
  imageDataUrl?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type StockMovement = {
  id: string;
  boxId: string;
  itemId: string;
  type: MovementType;
  quantity: number;
  beforeQuantity: number;
  afterQuantity: number;
  teamName?: string;
  exportExcluded?: boolean;
  imageDataUrl?: string;
  note?: string;
  createdAt: string;
};

export type BackupFile = {
  app: 'store-scan';
  version: number;
  exportedAt: string;
  boxes: Box[];
  items: Item[];
  movements: StockMovement[];
};
