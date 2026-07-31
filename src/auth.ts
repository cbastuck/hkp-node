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

export type AuthenticatedUser = { sub: string; email?: string };

/**
 * Owner key used when authentication is disabled. Every request collapses into
 * this single tenant, which is exactly the pre-multi-tenancy behaviour.
 */
export const ANONYMOUS_SUB = "anonymous";

/**
 * The tenant a request belongs to. Runtimes are namespaced by this key, so a
 * runtime id is only ever resolved within the caller's own namespace.
 */
export function ownerKeyOf(user: AuthenticatedUser | undefined): string {
  return user?.sub ?? ANONYMOUS_SUB;
}

export type AuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

/**
 * How requests are authenticated.
 *
 * - `jwt`  — verify an Auth0 bearer token against the JWKS for `domain`/`audience`.
 *   When `allowedEmails` is set, the token must additionally carry a **verified**
 *   `email` claim that is on the list; any other authenticated user of the
 *   tenant is rejected.
 * - `none` — accept everything (no identity). Only ever resolved for a local
 *   development checkout that opts in via ALLOW_NO_AUTH; the published npm
 *   package never runs in this mode (see resolveServerAuthConfig in index.ts).
 */
export type AuthConfig =
  | { mode: "jwt"; domain: string; audience: string; allowedEmails?: string[] }
  | { mode: "none" };

/**
 * Resolves an opaque (non-JWT) bearer token to a principal, or null if unknown.
 * Used for coordinator **session tokens**: short random strings the runtime
 * itself mints (gated by a user JWT) and hands to the coordinator, so the
 * coordinator can make long-lived machine calls on that user's behalf without a
 * user JWT that would expire. The token resolves back to the user it was minted
 * for, so there is no unscoped "service" superuser.
 */
export type OpaqueTokenResolver = (
  token: string,
) => AuthenticatedUser | null;

export type AuthenticatorOptions = {
  resolveOpaqueToken?: OpaqueTokenResolver;
};

/**
 * Resolved auth surface shared by HTTP and WebSocket entry points so both apply
 * the exact same checks.
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

/**
 * Email-allowlist gate applied after signature verification. Fail closed: when
 * a list is configured, a token without an `email` claim — or with an
 * unverified one — is rejected, because on tenants that allow self-signup an
 * attacker could otherwise register an allowlisted address without owning it.
 */
export function isEmailAllowed(
  claims: { [claim: string]: unknown },
  allowedEmails: string[] | undefined,
): boolean {
  if (!allowedEmails) {
    return true;
  }
  if (typeof claims.email !== "string" || claims.email_verified !== true) {
    return false;
  }
  return allowedEmails.includes(claims.email.trim().toLowerCase());
}

function createJwtVerifier(
  domain: string,
  audience: string,
  allowedEmails?: string[],
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
        if (!sub || !isEmailAllowed(decoded, allowedEmails)) {
          resolve(null);
          return;
        }
        const email =
          typeof decoded.email === "string" ? decoded.email : undefined;
        resolve({ sub, ...(email ? { email } : {}) });
      });
    });
}

export function createAuthenticator(
  config: AuthConfig,
  options: AuthenticatorOptions = {},
): Authenticator {
  if (config.mode === "none") {
    return {
      // Identity is irrelevant in no-auth mode, but tenant resolution still
      // needs a principal, so set the same stable one both entry points use.
      // Everything then lands in a single "anonymous" namespace.
      middleware: (req, _res, next) => {
        req.authenticatedUser = { sub: ANONYMOUS_SUB };
        next();
      },
      verifyToken: async () => ({ sub: ANONYMOUS_SUB }),
    };
  }

  const verify = createJwtVerifier(
    config.domain,
    config.audience,
    config.allowedEmails,
  );

  const verifyToken = async (
    token: string | undefined | null,
  ): Promise<AuthenticatedUser | null> => {
    if (!token) {
      return null;
    }
    // Session tokens are opaque and resolve locally without a network round-trip,
    // so check them before falling back to JWT verification.
    const opaque = options.resolveOpaqueToken?.(token);
    if (opaque) {
      return opaque;
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
