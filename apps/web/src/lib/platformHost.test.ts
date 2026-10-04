import { describe, expect, it } from 'vitest';
import { isDevHost, isPlatformHost } from './platformHost';

/** admin.<domain> is the platform panel; every other host is the studio app; localhost runs both. */
describe('isPlatformHost', () => {
  it('is true only for an admin. subdomain', () => {
    expect(isPlatformHost('admin.studiocrm.in')).toBe(true);
    expect(isPlatformHost('admin.localhost')).toBe(true);
    expect(isPlatformHost('studiocrm.in')).toBe(false);
    expect(isPlatformHost('app.studiocrm.in')).toBe(false);
    // "admin" elsewhere in the name is a studio host, not the panel.
    expect(isPlatformHost('myadmin.studiocrm.in')).toBe(false);
    expect(isPlatformHost('studio.admin.in')).toBe(false);
  });

  it('treats localhost and 127.0.0.1 as development hosts', () => {
    expect(isDevHost('localhost')).toBe(true);
    expect(isDevHost('127.0.0.1')).toBe(true);
    expect(isDevHost('studiocrm.in')).toBe(false);
    expect(isDevHost('admin.studiocrm.in')).toBe(false);
  });
});
