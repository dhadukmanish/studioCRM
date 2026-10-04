import { describe, expect, it } from 'vitest';
import { isDevHost, isPlatformHost } from './platformHost';

/** control.<domain> is the platform panel; every other host is the studio app; localhost runs both. */
describe('isPlatformHost', () => {
  it('is true only for a control. subdomain', () => {
    expect(isPlatformHost('control.studiocrm.in')).toBe(true);
    expect(isPlatformHost('control.localhost')).toBe(true);
    expect(isPlatformHost('studiocrm.in')).toBe(false);
    expect(isPlatformHost('app.studiocrm.in')).toBe(false);
    // "control" elsewhere in the name is a studio host, not the panel.
    expect(isPlatformHost('mycontrol.studiocrm.in')).toBe(false);
    expect(isPlatformHost('studio.control.in')).toBe(false);
  });

  it('treats localhost and 127.0.0.1 as development hosts', () => {
    expect(isDevHost('localhost')).toBe(true);
    expect(isDevHost('127.0.0.1')).toBe(true);
    expect(isDevHost('studiocrm.in')).toBe(false);
    expect(isDevHost('control.studiocrm.in')).toBe(false);
  });
});
