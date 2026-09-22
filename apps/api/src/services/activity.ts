import type { FastifyRequest } from 'fastify';
import { db, schema } from '../db/client';

/** Fire-and-forget audit log. Never throws. */
export async function logActivity(req: FastifyRequest, entityType: string, entityId: string | null, action: string, description: string, meta: Record<string, unknown> = {}) {
  try {
    await db.insert(schema.activityLogs).values({ tenantId: req.user.tenantId, entityType, entityId, action, description, meta: { ...meta, userName: req.user.name }, userId: req.user.id, ipAddress: req.ip });
  } catch (e) {
    req.log.warn({ err: e }, 'activity log failed');
  }
}
