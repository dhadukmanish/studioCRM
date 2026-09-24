import { describe, it, expect } from 'vitest';
import { listenTarget, describeTarget } from './listen';

/**
 * Where the server listens. Pure, no database, always runs.
 *
 * This exists because of a real outage: IIS's httpPlatformHandler passes %HTTP_PLATFORM_PORT%
 * padded with trailing spaces, the untrimmed value did not look numeric, so it was taken for a
 * named pipe and Node exited with ERR_INVALID_ARG_VALUE. The process started, logged that it was
 * serving, and died — every request a 502 with nothing in the log to point at the cause.
 */
describe('where the server listens', () => {
  it('takes a plain port and binds every interface', () => {
    expect(listenTarget('4000')).toEqual({ port: 4000, host: '0.0.0.0' });
  });

  it('trims the padding IIS adds to %HTTP_PLATFORM_PORT%', () => {
    // The exact shape from the failed deployment's node.log.
    expect(listenTarget('19281               ')).toEqual({ port: 19281, host: '0.0.0.0' });
  });

  it('trims whitespace on either side, and a trailing newline', () => {
    expect(listenTarget('  8080  ')).toEqual({ port: 8080, host: '0.0.0.0' });
    expect(listenTarget('8080\r\n')).toEqual({ port: 8080, host: '0.0.0.0' });
  });

  it('passes a named pipe through unchanged rather than coercing it', () => {
    // iisnode hands over a pipe. Number('\\\\.\\pipe\\x') is NaN, and listening on port 0 would
    // mean the site never answers, so the value must survive as a path.
    expect(listenTarget('\\\\.\\pipe\\1a2b3c')).toEqual({ path: '\\\\.\\pipe\\1a2b3c' });
  });

  it('trims a padded pipe path too', () => {
    expect(listenTarget('  \\\\.\\pipe\\1a2b3c  ')).toEqual({ path: '\\\\.\\pipe\\1a2b3c' });
  });

  it('falls back when PORT is unset, empty or only whitespace', () => {
    expect(listenTarget(undefined)).toEqual({ port: 4000, host: '0.0.0.0' });
    expect(listenTarget('')).toEqual({ port: 4000, host: '0.0.0.0' });
    expect(listenTarget('    ')).toEqual({ port: 4000, host: '0.0.0.0' });
  });

  it('honours an explicit fallback', () => {
    expect(listenTarget(undefined, '5000')).toEqual({ port: 5000, host: '0.0.0.0' });
  });

  it('never yields port 0 from a non-numeric value', () => {
    for (const value of ['abc', '80a', '\\\\.\\pipe\\x', ' ']) {
      const target = listenTarget(value);
      if ('port' in target) expect(target.port).not.toBe(0);
    }
  });

  it('describes both shapes for the startup line', () => {
    expect(describeTarget({ port: 4000, host: '0.0.0.0' })).toBe('http://localhost:4000');
    expect(describeTarget({ path: '\\\\.\\pipe\\x' })).toBe('\\\\.\\pipe\\x');
  });
});
