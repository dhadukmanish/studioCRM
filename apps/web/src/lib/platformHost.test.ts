import { describe, expect, it } from 'vitest';
import { isPlatformHost } from './platformHost';

/** A control.<domain> host serving the build shows only the panel; /platform exists on every host. */
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
});
