import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authenticatedUser?: AuthenticatedUser;
    }
  }
}

export type AuthenticatedUser = { sub: string };

export type AuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

/**
 * How requests are authenticated.
 *
 * - `jwt`  — verify an Auth0 bearer token against the JWKS for `domain`/`audience`.
 * - `none` — accept everything (no identity). Only ever resolved for a local
 *   development checkout that opts in via ALLOW_NO_AUTH; the published npm
 *   package never runs in this mode (see resolveServerAuthConfig in index.ts).
 */
export type AuthConfig =
  | { mode: "jwt"; domain: string; audience: string }
  | { mode: "none" };

/**
 * Resolved auth surface shared by HTTP and WebSocket entry points so both apply
 * the exact same checks. `serviceToken`, when set, is a shared machine-to-machine
 * secret accepted in place of a user JWT (used by the coordinator to reach the
 * runtimes it provisions).
 */
export type Authenticator = {
  /** Express middleware for HTTP routes. Sets req.authenticatedUser on success. */
  middleware: AuthMiddleware;
  /**
   * Verify a raw token string (from a WebSocket `?access_token=` query param or
   * an Authorization bearer value). Resolves to the principal or null.
   */
  verifyToken(token: string | undefined | null): Promise<AuthenticatedUser | null>;
};

function createJwtVerifier(
  domain: string,
  audience: string,
): (token: string) => Promise<AuthenticatedUser | null> {
  const client = jwksClient({
    jwksUri: `https://${domain}/.well-known/jwks.json`,
    cache: true,
    rateLimit: true,
  });

  function getSigningKey(
    header: jwt.JwtHeader,
    callback: jwt.SigningKeyCallback,
  ) {
    client.getSigningKey(header.kid, (err, key) => {
      if (err) {
        callback(err);
        return;
      }
      callback(null, key?.getPublicKey());
    });
  }

  return (token: string) =>
    new Promise<AuthenticatedUser | null>((resolve) => {
      jwt.verify(token, getSigningKey, { audience }, (err, decoded) => {
        if (err || !decoded || typeof decoded === "string") {
          resolve(null);
          return;
        }
        const sub = typeof decoded.sub === "string" ? decoded.sub : null;
        resolve(sub ? { sub } : null);
      });
    });
}

export function createAuthenticator(
  config: AuthConfig,
  serviceToken?: string,
): Authenticator {
  if (config.mode === "none") {
    return {
      middleware: (_req, _res, next) => next(),
      // Identity is irrelevant in no-auth mode; hand back a stable principal so
      // downstream code that reads `sub` still works.
      verifyToken: async () => ({ sub: "anonymous" }),
    };
  }

  const verify = createJwtVerifier(config.domain, config.audience);

  const verifyToken = async (
    token: string | undefined | null,
  ): Promise<AuthenticatedUser | null> => {
    if (!token) {
      return null;
    }
    if (serviceToken && token === serviceToken) {
      return { sub: "service" };
    }
    return verify(token);
  };

  return {
    middleware: (req, res, next) => {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        res.sendStatus(401);
        return;
      }
      void verifyToken(header.slice(7)).then((user) => {
        if (!user) {
          res.sendStatus(401);
          return;
        }
        req.authenticatedUser = user;
        next();
      });
    },
    verifyToken,
  };
}

/**
 * List of origins permitted to talk to this instance. `"*"` reflects any origin
 * (only sensible for local/no-auth development).
 */
export type AllowedOrigins = "*" | string[];

/**
 * True when the bind address is reachable only from the local machine. A
 * loopback bind is itself an access-control boundary — nothing off-machine can
 * connect — so running without authentication there is safe.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.")
  );
}

/**
 * Cross-Site WebSocket Hijacking protection. Browsers always send an Origin
 * header on the WS handshake, so a mismatched one is a cross-site attempt and is
 * rejected. Non-browser clients (e.g. the coordinator) send no Origin; they are
 * allowed through here and gated by the token check instead.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowed: AllowedOrigins,
): boolean {
  if (allowed === "*") {
    return true;
  }
  if (origin === undefined) {
    return true;
  }
  return allowed.includes(origin);
}
