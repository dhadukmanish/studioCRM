/**
 * Where the server should listen, worked out from `PORT`.
 *
 * Its own module, and pure, because getting this wrong takes the whole site down and leaves
 * almost no clue: the process starts, logs that it is serving, and then exits. It is worth a test.
 *
 * Two shapes have to survive:
 *
 * - **A port number.** Any plain Node host, and IIS through `httpPlatformHandler`, which picks a
 *   free port and passes it as `%HTTP_PLATFORM_PORT%`. It hands that value over **padded with
 *   trailing spaces**, so the value must be trimmed before it is tested — otherwise `'19281   '`
 *   is not numeric, is taken for a pipe path, and Node exits with `ERR_INVALID_ARG_VALUE`. That
 *   is exactly how the first deployment failed.
 * - **A named pipe.** iisnode passes something like `\\.\pipe\xxx` instead of a port. Coercing
 *   that with `Number()` would listen on port 0 and the site would never answer, which is why a
 *   non-numeric value is passed through unchanged rather than converted.
 */
export type ListenTarget = { port: number; host: string } | { path: string };

export function listenTarget(portEnv: string | undefined, fallback = '4000'): ListenTarget {
  const value = (portEnv ?? fallback).trim();
  if (value === '') return { port: Number(fallback), host: '0.0.0.0' };
  // Host stays 0.0.0.0: the process may be reached over a loopback proxy or directly.
  return /^\d+$/.test(value) ? { port: Number(value), host: '0.0.0.0' } : { path: value };
}

/** How to describe the target in a startup log line. */
export const describeTarget = (target: ListenTarget) =>
  'port' in target ? `http://localhost:${target.port}` : target.path;
