import crypto from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from './db.js';
import { sessions } from './schema.js';

export type AuthUser = { id: string; username: string };

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: AuthUser;
  }
}

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export const createShareToken = () => crypto.randomBytes(32).toString('base64url');
export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);

export const createSession = async (app: FastifyInstance, user: AuthUser) => {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await db.insert(sessions).values({
    userId: user.id,
    refreshTokenHash: sha256(refreshToken),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  return {
    accessToken: app.jwt.sign(user, { expiresIn: '15m' }),
    refreshToken,
    user,
  };
};

export const requireAuth = async (request: FastifyRequest) => request.jwtVerify();

export const revokeRefreshToken = async (token: string) => {
  await db.delete(sessions).where(eq(sessions.refreshTokenHash, sha256(token)));
};
