import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const dates = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  ...dates,
}, (table) => [uniqueIndex('users_username_unique').on(table.username)]);

export const loginLogs = pgTable('login_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  username: text('username').notNull(),
  ip: text('ip'),
  success: boolean('success').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 操作审计日志：记录所有用户的敏感与非敏感操作，便于溯源
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  username: text('username').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  detail: text('detail'),
  ip: text('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  refreshTokenHash: text('refresh_token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const boxes = pgTable('boxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  code: text('code').notNull(),
  note: text('note'),
  imageDataUrl: text('image_data_url'),
  shareTokenHash: text('share_token_hash').notNull(),
  shareToken: text('share_token').notNull(),
  archived: boolean('archived').notNull().default(false),
  ...dates,
}, (table) => [
  uniqueIndex('boxes_owner_code_unique').on(table.ownerId, table.code),
]);

export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  boxId: uuid('box_id').notNull().references(() => boxes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  specModel: text('spec_model'),
  quantity: integer('quantity').notNull().default(0),
  unit: text('unit'),
  lowStockThreshold: integer('low_stock_threshold'),
  imageDataUrl: text('image_data_url'),
  note: text('note'),
  ...dates,
});

export const movements = pgTable('movements', {
  id: uuid('id').primaryKey().defaultRandom(),
  boxId: uuid('box_id').notNull().references(() => boxes.id, { onDelete: 'cascade' }),
  itemId: uuid('item_id').notNull().references(() => items.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  quantity: integer('quantity').notNull(),
  beforeQuantity: integer('before_quantity').notNull(),
  afterQuantity: integer('after_quantity').notNull(),
  teamName: text('team_name'),
  exportExcluded: boolean('export_excluded').notNull().default(false),
  imageDataUrl: text('image_data_url'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const syncOperations = pgTable('sync_operations', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  result: text('result').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
