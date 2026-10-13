import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/** Environment variable holding the bearer token every `renor serve` route requires. */
export const API_TOKEN_ENV = 'RENOR_API_TOKEN';

/** Host names the local API answers to. Anything else is a page rebinding its own domain to loopback. */
export const LOCAL_API_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/**
 * The token `renor serve` was started with, or a refusal naming the variable. A local API with no
 * credential is open to every user of the machine (loopback is shared), so there is no default and no
 * "open" mode: an unset or blank token is a start failure.
 */
export function requireApiToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env[API_TOKEN_ENV]?.trim();
  if (!token) {
    throw new Error(
      `${API_TOKEN_ENV} is not set. The HTTP API (renor serve) has no other protection: any user on this machine `
      + 'can reach 127.0.0.1. Refusing to start without a bearer token (fail closed). '
      + `Set ${API_TOKEN_ENV} to a long random value (for example: export ${API_TOKEN_ENV}=$(openssl rand -hex 32)) `
      + 'and send it as "Authorization: Bearer <token>" on every request.',
    );
  }
  return token;
}

/** Express middleware: `Authorization: Bearer <token>` is required, compared in constant time. */
export function bearerTokenGuard(token: string) {
  const expected = digest(token);
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer +(.+)$/i.exec(header) : null;
    if (match && crypto.timingSafeEqual(digest(match[1].trim()), expected)) return next();
    res.set('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'unauthorized' });
  };
}
