import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { and, eq, gt, or } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db, schema } from '../db/client';
import { loginSchema, changePasswordSchema, profileSchema, PERMISSIONS, allPermissions } from '@erp/shared';
import { parse } from '../lib/validate';
import { AppError, validation } from '../lib/errors';
import { ok } from '../lib/respond';
import { loadAuthUser } from '../plugins/auth';
import { getSettings } from '../services/settings';

const REFRESH_DAYS = 30;

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req) => {
    const body = parse(loginSchema, req.body);
    const ident = body.email.trim().toLowerCase();
    const [u] = await db.select().from(schema.users).where(or(eq(schema.users.email, ident), eq(schema.users.username, ident))).limit(1);
    if (!u || !(await bcrypt.compare(body.password, u.passwordHash))) throw new AppError('AUTH_001', 'Invalid email or password', 401);
    if (!u.isActive) throw new AppError('AUTH_004', 'This account is inactive', 403);
    const settings = await getSettings(u.tenantId);
    const accessToken = app.jwt.sign({ sub: u.id, tenantId: u.tenantId }, { expiresIn: `${settings.sessionHours}h` });
    const refreshToken = randomBytes(48).toString('hex');
    await db.insert(schema.refreshTokens).values({ userId: u.id, token: refreshToken, expiresAt: new Date(Date.now() + REFRESH_DAYS * 86400000) });
    await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, u.id));
    const user = await loadAuthUser(u.id);
    const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, u.tenantId));
    return ok({ accessToken, refreshToken, user: { ...user, tenantName: tenant?.name, avatarUrl: u.avatarUrl } }, 'Login successful');
  });

  app.post('/api/auth/refresh', async (req) => {
    const token = (req.body as any)?.refreshToken as string | undefined;
    if (!token) throw new AppError('AUTH_003', 'No token provided', 401);
    const [rt] = await db.select().from(schema.refreshTokens).where(and(eq(schema.refreshTokens.token, token), gt(schema.refreshTokens.expiresAt, new Date())));
    if (!rt) throw new AppError('AUTH_003', 'Refresh token expired', 401);
    const user = await loadAuthUser(rt.userId);
    if (!user) throw new AppError('AUTH_004', 'Account is inactive', 403);
    const settings = await getSettings(user.tenantId);
    const accessToken = app.jwt.sign({ sub: user.id, tenantId: user.tenantId }, { expiresIn: `${settings.sessionHours}h` });
    return ok({ accessToken, user });
  });

  app.post('/api/auth/logout', { preHandler: app.authenticate }, async (req) => {
    const token = (req.body as any)?.refreshToken as string | undefined;
    if (token) await db.delete(schema.refreshTokens).where(eq(schema.refreshTokens.token, token));
    return ok(null, 'Logged out');
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req) => {
    const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, req.user.tenantId));
    const [u] = await db.select({ avatarUrl: schema.users.avatarUrl, mobile: schema.users.mobile, firstName: schema.users.firstName, lastName: schema.users.lastName }).from(schema.users).where(eq(schema.users.id, req.user.id));
    return ok({ ...req.user, ...u, tenantName: tenant?.name });
  });

  /** Effective permissions of the current user (super admin → everything). */
  app.get('/api/auth/permissions', { preHandler: app.authenticate }, async (req) => {
    const grants = req.user.isSuperAdmin ? allPermissions() : req.user.grants;
    return ok({ role: req.user.roleName, roleKey: req.user.roleKey, grants, catalog: PERMISSIONS });
  });

  app.put('/api/auth/profile', { preHandler: app.authenticate }, async (req) => {
    const body = parse(profileSchema, req.body);
    await db.update(schema.users).set({ ...body, updatedAt: new Date() }).where(eq(schema.users.id, req.user.id));
    return ok(await loadAuthUser(req.user.id), 'Profile updated');
  });

  app.put('/api/auth/change-password', { preHandler: app.authenticate }, async (req) => {
    const body = parse(changePasswordSchema, req.body);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, req.user.id));
    if (!u || !(await bcrypt.compare(body.currentPassword, u.passwordHash))) throw validation('Current password is incorrect');
    await db.update(schema.users).set({ passwordHash: await bcrypt.hash(body.newPassword, 10), updatedAt: new Date() }).where(eq(schema.users.id, req.user.id));
    await db.delete(schema.refreshTokens).where(eq(schema.refreshTokens.userId, req.user.id));
    return ok(null, 'Password changed — please sign in again');
  });
}
