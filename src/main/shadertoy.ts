import { net } from 'electron';

/**
 * Fetches a shader from shadertoy.com's public API.
 *
 * This lives in the main process rather than the renderer for two reasons: the
 * renderer's Content-Security-Policy is `default-src 'self'`, which correctly
 * forbids it from reaching arbitrary hosts, and the API key should not be
 * handed to page code at all.
 *
 * The API requires a free key from https://www.shadertoy.com/howto#q2 - there
 * is no unauthenticated endpoint. The site's own internal endpoint is not used
 * here: it is undocumented, unsupported, and would break the moment they
 * changed it.
 */

const API_HOST = 'https://www.shadertoy.com';
const TIMEOUT_MS = 20000;

export interface ShadertoyFetchResult {
  ok: boolean;
  /** Raw `Shader` object from the API. */
  shader?: unknown;
  error?: string;
}

/** Reject anything that isn't a plausible shader id before making a request. */
function isValidId(id: string): boolean {
  return /^[A-Za-z0-9]{3,12}$/.test(id);
}

export async function fetchShadertoy(id: string, apiKey: string): Promise<ShadertoyFetchResult> {
  if (!isValidId(id)) {
    return { ok: false, error: `"${id}" is not a valid Shadertoy id.` };
  }
  if (!apiKey.trim()) {
    return { ok: false, error: 'No Shadertoy API key set.' };
  }

  const url = `${API_HOST}/api/v1/shaders/${encodeURIComponent(id)}?key=${encodeURIComponent(apiKey.trim())}`;

  let body: string;
  try {
    body = await requestText(url);
  } catch (err) {
    return { ok: false, error: `Could not reach Shadertoy: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A bad key returns an HTML error page rather than JSON, which is the most
    // common way this fails, so name that case specifically.
    return {
      ok: false,
      error: body.includes('<html')
        ? 'Shadertoy returned a web page instead of shader data. The API key is probably wrong.'
        : 'Shadertoy returned something that was not valid JSON.',
    };
  }

  const record = parsed as { Error?: string; Shader?: unknown };

  if (record.Error) {
    const message = String(record.Error);
    if (/key/i.test(message)) {
      return { ok: false, error: `Shadertoy rejected the API key: ${message}` };
    }
    return { ok: false, error: `Shadertoy: ${message}` };
  }

  if (!record.Shader) {
    return {
      ok: false,
      error:
        'Shadertoy returned no shader. The id may be wrong, or the shader may be private ' +
        'or not published with the "public + API" setting its author must choose.',
    };
  }

  return { ok: true, shader: record.Shader };
}

/**
 * Minimal GET returning the body as text.
 *
 * Uses Electron's `net` module rather than Node's https so the request goes
 * through Chromium's stack and picks up the system proxy configuration, which
 * matters on corporate networks.
 */
function requestText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.abort();
      reject(new Error('the request timed out'));
    }, TIMEOUT_MS);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      let size = 0;

      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        // A shader is a few hundred kB at most; anything far larger is not
        // something we should be buffering.
        if (size > 8 * 1024 * 1024) {
          finish(() => reject(new Error('response too large')));
          return;
        }
        chunks.push(chunk);
      });

      response.on('end', () => {
        const status = response.statusCode ?? 0;
        const text = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) {
          finish(() => reject(new Error(`HTTP ${status}`)));
          return;
        }
        finish(() => resolve(text));
      });

      response.on('error', (err: Error) => finish(() => reject(err)));
    });

    request.on('error', (err) => finish(() => reject(err)));
    request.end();
  });
}
