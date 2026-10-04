/**
 * One-time platform bootstrap (docs/SUBSCRIPTIONS.md) — idempotent, safe to re-run: creates the
 * first platform admin from env vars, or with --reset-password resets theirs. It creates no plans —
 * the platform defines every plan (name, type, days, price) itself in the panel's Plans page.
 *
 *   PLATFORM_ADMIN_EMAIL=you@company.com PLATFORM_ADMIN_NAME="Your Name" PLATFORM_ADMIN_PASSWORD=... \
 *     pnpm --filter @erp/api platform:setup [--reset-password]
 *
 * The password is read from the environment so it never lands in a command's arguments, and it is
 * never printed. Only the database host/name is shown.
 */
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db, schema, sql, DATABASE_URL } from './client';

async function main() {
  const u = new URL(DATABASE_URL);
  console.log(`Database: ${u.hostname}:${u.port || 5432}${u.pathname}`);

  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  const name = process.env.PLATFORM_ADMIN_NAME?.trim() || 'Platform Admin';
  if (!email) return console.log('Admin: PLATFORM_ADMIN_EMAIL not set — skipped');
  const [admin] = await db.select().from(schema.platformAdmins).where(eq(schema.platformAdmins.email, email));
  const reset = process.argv.includes('--reset-password');
  if (admin && !reset) return console.log(`Admin: ${email} already exists — pass --reset-password to change the password`);
  if (!password || password.length < 8) throw new Error('PLATFORM_ADMIN_PASSWORD must be set and at least 8 characters');
  const passwordHash = await bcrypt.hash(password, 10);
  if (admin) {
    await db.update(schema.platformAdmins).set({ passwordHash, isActive: true, updatedAt: new Date() }).where(eq(schema.platformAdmins.id, admin.id));
    console.log(`Admin: password reset for ${email}`);
  } else {
    await db.insert(schema.platformAdmins).values({ email, name, passwordHash });
    console.log(`Admin: created ${email}`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
