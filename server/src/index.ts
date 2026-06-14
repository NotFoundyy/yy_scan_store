import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { createSession, createShareToken, hashPassword, requireAuth, revokeRefreshToken, sha256, verifyPassword } from './auth.js';
import { db, rawPool } from './db.js';
import { boxes, items, movements, sessions, syncOperations, users } from './schema.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: process.env.CORS_ORIGIN === '*' ? true : process.env.CORS_ORIGIN });
await app.register(jwt, { secret: process.env.JWT_SECRET! });

const credentials = z.object({
  username: z.string().regex(/^[A-Za-z0-9_]{4,32}$/),
  password: z.string().min(8).max(128),
});
const boxInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(100),
  code: z.string().min(1).max(100).optional(),
  note: z.string().optional(),
  imageDataUrl: z.string().optional(),
  createdAt: z.string().optional(),
});
const itemInput = z.object({
  id: z.string().uuid().optional(),
  boxId: z.string().uuid(),
  name: z.string().min(1).max(100),
  specModel: z.string().optional(),
  quantity: z.number().int().min(0),
  unit: z.string().optional(),
  lowStockThreshold: z.number().int().optional(),
  imageDataUrl: z.string().optional(),
  note: z.string().optional(),
  createdAt: z.string().optional(),
});

const ownBox = async (ownerId: string, id: string) => {
  const [box] = await db.select().from(boxes).where(and(eq(boxes.id, id), eq(boxes.ownerId, ownerId)));
  return box;
};

app.get('/health', async () => ({ ok: true }));

app.post('/auth/register', async (request, reply) => {
  const input = credentials.parse(request.body);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, input.username));
  if (existing) return reply.status(409).send({ message: '账号已存在' });
  const [user] = await db.insert(users).values({ username: input.username, passwordHash: await hashPassword(input.password) }).returning();
  return createSession(app, { id: user!.id, username: user!.username });
});

app.post('/auth/login', async (request, reply) => {
  const input = credentials.parse(request.body);
  const [user] = await db.select().from(users).where(eq(users.username, input.username));
  if (!user || !(await verifyPassword(user.passwordHash, input.password))) return reply.status(401).send({ message: '账号或密码错误' });
  return createSession(app, { id: user.id, username: user.username });
});

app.post('/auth/refresh', async (request, reply) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(request.body);
  const [session] = await db.select().from(sessions).where(eq(sessions.refreshTokenHash, sha256(refreshToken)));
  if (!session || session.expiresAt < new Date()) return reply.status(401).send({ message: '登录已过期' });
  const [user] = await db.select().from(users).where(eq(users.id, session.userId));
  if (!user) return reply.status(401).send({ message: '登录已过期' });
  await revokeRefreshToken(refreshToken);
  return createSession(app, { id: user.id, username: user.username });
});

app.post('/auth/logout', async (request) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(request.body);
  await revokeRefreshToken(refreshToken);
  return { ok: true };
});

app.post('/import', { preHandler: requireAuth }, async (request) => {
  const input = z.object({
    boxes: z.array(boxInput.extend({ id: z.string().uuid(), code: z.string() })),
    items: z.array(itemInput.extend({ id: z.string().uuid() })),
    movements: z.array(z.object({
      id: z.string().uuid(), boxId: z.string().uuid(), itemId: z.string().uuid(),
      type: z.enum(['in', 'out', 'adjust']), quantity: z.number().int().min(0),
      beforeQuantity: z.number().int(), afterQuantity: z.number().int(), teamName: z.string().optional(),
      exportExcluded: z.boolean().optional(), imageDataUrl: z.string().optional(), note: z.string().optional(), createdAt: z.string(),
    })),
  }).parse(request.body);
  const allowedBoxIds = new Set(input.boxes.map((box) => box.id));
  const allowedItemIds = new Set(input.items.filter((item) => allowedBoxIds.has(item.boxId)).map((item) => item.id));
  await db.transaction(async (tx) => {
    for (const inputBox of input.boxes) {
      const shareToken = createShareToken();
      await tx.insert(boxes).values({
        ...inputBox,
        ownerId: request.user.id,
        shareToken,
        shareTokenHash: sha256(shareToken),
        createdAt: inputBox.createdAt ? new Date(inputBox.createdAt) : new Date(),
        updatedAt: new Date(),
      }).onConflictDoNothing();
    }
    for (const inputItem of input.items.filter((item) => allowedBoxIds.has(item.boxId))) {
      await tx.insert(items).values({
        ...inputItem,
        createdAt: inputItem.createdAt ? new Date(inputItem.createdAt) : new Date(),
        updatedAt: new Date(),
      }).onConflictDoNothing();
    }
    for (const movement of input.movements.filter((entry) => allowedBoxIds.has(entry.boxId) && allowedItemIds.has(entry.itemId))) {
      await tx.insert(movements).values({ ...movement, createdAt: new Date(movement.createdAt) }).onConflictDoNothing();
    }
  });
  return { boxes: input.boxes.length, items: allowedItemIds.size };
});

app.get('/data', { preHandler: requireAuth }, async (request) => {
  const ownerBoxes = await db.select().from(boxes).where(eq(boxes.ownerId, request.user.id)).orderBy(desc(boxes.updatedAt));
  const ids = new Set(ownerBoxes.map((box) => box.id));
  const resultItems = ids.size ? await db.select().from(items).where(inArray(items.boxId, [...ids])) : [];
  const resultMovements = ids.size ? await db.select().from(movements).where(inArray(movements.boxId, [...ids])).orderBy(desc(movements.createdAt)) : [];
  return {
    boxes: ownerBoxes.filter((box) => !box.archived).map((box) => ({ ...box, createdAt: box.createdAt.toISOString(), updatedAt: box.updatedAt.toISOString() })),
    items: resultItems.filter((item) => ids.has(item.boxId)).map((item) => ({ ...item, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() })),
    movements: resultMovements.filter((movement) => ids.has(movement.boxId)).map((movement) => ({ ...movement, createdAt: movement.createdAt.toISOString() })),
  };
});

app.post('/boxes', { preHandler: requireAuth }, async (request) => {
  const input = boxInput.parse(request.body);
  const shareToken = createShareToken();
  const now = input.createdAt ? new Date(input.createdAt) : new Date();
  const [box] = await db.insert(boxes).values({
    id: input.id ?? crypto.randomUUID(),
    ownerId: request.user.id,
    name: input.name.trim(),
    code: input.code ?? `YCK-${Date.now()}`,
    note: input.note,
    imageDataUrl: input.imageDataUrl,
    shareToken,
    shareTokenHash: sha256(shareToken),
    createdAt: now,
    updatedAt: now,
  }).returning();
  return box;
});

app.patch('/boxes/:id', { preHandler: requireAuth }, async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  if (!(await ownBox(request.user.id, id))) return reply.status(404).send({ message: '箱子不存在' });
  const input = boxInput.partial().parse(request.body);
  const { createdAt: _createdAt, id: _inputId, ...changes } = input;
  const [box] = await db.update(boxes).set({ ...changes, updatedAt: new Date() }).where(eq(boxes.id, id)).returning();
  return box;
});

app.delete('/boxes/:id', { preHandler: requireAuth }, async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  if (!(await ownBox(request.user.id, id))) return reply.status(404).send({ message: '箱子不存在' });
  await db.delete(boxes).where(eq(boxes.id, id));
  return { ok: true };
});

app.post('/items', { preHandler: requireAuth }, async (request, reply) => {
  const input = itemInput.parse(request.body);
  if (!(await ownBox(request.user.id, input.boxId))) return reply.status(404).send({ message: '箱子不存在' });
  const now = input.createdAt ? new Date(input.createdAt) : new Date();
  const { createdAt: _createdAt, id: inputId, ...itemValues } = input;
  const [item] = await db.insert(items).values({ ...itemValues, id: inputId ?? crypto.randomUUID(), createdAt: now, updatedAt: now }).returning();
  if (input.quantity > 0) await db.insert(movements).values({
    id: crypto.randomUUID(), boxId: input.boxId, itemId: item!.id, type: 'in', quantity: input.quantity,
    beforeQuantity: 0, afterQuantity: input.quantity, note: '初始库存', createdAt: now,
  });
  return item;
});

app.patch('/items/:id', { preHandler: requireAuth }, async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const [current] = await db.select().from(items).where(eq(items.id, id));
  if (!current || !(await ownBox(request.user.id, current.boxId))) return reply.status(404).send({ message: '物品不存在' });
  const input = itemInput.partial().omit({ boxId: true, id: true }).parse(request.body);
  const { createdAt: _createdAt, ...changes } = input;
  const [item] = await db.transaction(async (tx) => {
    const [updated] = await tx.update(items).set({ ...changes, updatedAt: new Date() }).where(eq(items.id, id)).returning();
    if (input.quantity !== undefined && input.quantity !== current.quantity) {
      await tx.insert(movements).values({
        id: crypto.randomUUID(),
        boxId: current.boxId,
        itemId: current.id,
        type: 'adjust',
        quantity: Math.abs(input.quantity - current.quantity),
        beforeQuantity: current.quantity,
        afterQuantity: input.quantity,
        note: '手动调整库存',
      });
    }
    return [updated];
  });
  return item;
});

app.delete('/items/:id', { preHandler: requireAuth }, async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const [item] = await db.select().from(items).where(eq(items.id, id));
  if (!item || !(await ownBox(request.user.id, item.boxId))) return reply.status(404).send({ message: '物品不存在' });
  await db.delete(items).where(eq(items.id, id));
  return { ok: true };
});

app.post('/items/:id/movements', { preHandler: requireAuth }, async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const input = z.object({
    operationId: z.string().uuid(), type: z.enum(['in', 'out']), quantity: z.number().int().positive(),
    teamName: z.string().optional(), note: z.string().optional(), imageDataUrl: z.string().optional(), createdAt: z.string().optional(),
  }).parse(request.body);
  const client = await rawPool.connect();
  try {
    await client.query('BEGIN');
    const duplicate = await client.query('SELECT result FROM sync_operations WHERE id = $1', [input.operationId]);
    if (duplicate.rowCount) {
      await client.query('ROLLBACK');
      return JSON.parse(duplicate.rows[0].result);
    }
    const row = await client.query(
      `SELECT i.*, b.owner_id FROM items i JOIN boxes b ON b.id=i.box_id WHERE i.id=$1 FOR UPDATE`,
      [id],
    );
    const item = row.rows[0];
    if (!item || item.owner_id !== request.user.id) {
      await client.query('ROLLBACK');
      return reply.status(404).send({ message: '物品不存在' });
    }
    const after = input.type === 'in' ? item.quantity + input.quantity : item.quantity - input.quantity;
    if (after < 0) {
      await client.query('ROLLBACK');
      return reply.status(409).send({ message: '库存不足' });
    }
    const movementId = crypto.randomUUID();
    const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
    await client.query('UPDATE items SET quantity=$1, updated_at=NOW() WHERE id=$2', [after, id]);
    await client.query(
      `INSERT INTO movements(id,box_id,item_id,type,quantity,before_quantity,after_quantity,team_name,note,image_data_url,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [movementId, item.box_id, id, input.type, input.quantity, item.quantity, after, input.teamName, input.note, input.imageDataUrl, createdAt],
    );
    const result = { item: { ...item, quantity: after }, movementId };
    await client.query('INSERT INTO sync_operations(id,owner_id,result) VALUES($1,$2,$3)', [input.operationId, request.user.id, JSON.stringify(result)]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.get('/shared/boxes/:id', async (request, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  const { token } = z.object({ token: z.string().min(20) }).parse(request.query);
  const [box] = await db.select().from(boxes).where(eq(boxes.id, id));
  if (!box || box.archived || sha256(token) !== box.shareTokenHash) return reply.status(404).send({ message: '箱子不存在或二维码无效' });
  const publicItems = await db.select().from(items).where(eq(items.boxId, id));
  return {
    box: { id: box.id, name: box.name, code: box.code, imageDataUrl: box.imageDataUrl, updatedAt: box.updatedAt.toISOString() },
    items: publicItems.map(({ note: _note, ...item }) => item),
  };
});

app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
  if (error instanceof z.ZodError) return reply.status(400).send({ message: error.issues.map((issue) => issue.message).join(', ') });
  app.log.error(error);
  return reply.status(error.statusCode ?? 500).send({ message: error.message });
});

await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
