import { allowsOrigin, type AllowedOrigins } from "./origins";
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

/**
 * Who a verified token speaks for.
 *
 * `email` is present only when the token carries one **and** says it is
 * verified, and is normalised the way the lists it is compared with are. An
 * address somebody merely typed while signing up is dropped rather than
 * carried: everything that reads it — the server's allowlist, a board's member
 * list, a run's caller — treats it as proof of who is asking.
 */
export type AuthenticatedUser = { sub: string; email?: string };

/** An email as the lists it is compared with keep it. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

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
 *   When `allowedEmails` is set, owning anything here — a runtime, a board —
 *   additionally takes a **verified** `email` claim that is on the list. It
 *   gates who may own, not who may be identified: a deployed board's member
 *   list admits people the allowlist does not name, to that board only.
 *
 *   `audience` may list several accepted values. The frontend sends its id_token,
 *   whose `aud` is the Auth0 *client id* of whichever application signed the user
 *   in — and the web and native apps must be separate Auth0 applications (only a
 *   SPA-type one can do the browser flows, only a Native-type one the RFC 8252
 *   flow). One runtime serves users from both, so it accepts both client ids.
 * - `none` — accept everything (no identity). Only ever resolved for a local
 *   development checkout that opts in via ALLOW_NO_AUTH; the published npm
 *   package never runs in this mode (see resolveServerAuthConfig in index.ts).
 */
export type AuthConfig =
  | {
      mode: "jwt";
      domain: string;
      audience: string | string[];
      allowedEmails?: string[];
    }
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
  /**
   * Express middleware for HTTP routes: `authorizeOwner` on the bearer token.
   * Sets req.authenticatedUser on success.
   */
  middleware: AuthMiddleware;
  /**
   * Who a raw token speaks for, and nothing about what they may do: signature,
   * issuer, audience and `sub`, with the email only when it is verified. For
   * the paths that decide access by something narrower than the server's
   * allowlist — a deployed board's member list.
   */
  identifyToken(
    token: string | undefined | null,
  ): Promise<AuthenticatedUser | null>;
  /**
   * `identifyToken`, then the server's allowlist: whether this person may own
   * things here — runtimes, boards. What every route uses unless it says
   * otherwise. The token is a raw string, from a WebSocket `?access_token=`
   * query param or an Authorization bearer value.
   */
  authorizeOwner(
    token: string | undefined | null,
  ): Promise<AuthenticatedUser | null>;
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
  return allowedEmails.includes(normalizeEmail(claims.email));
}

/**
 * The allowlist asked of somebody already identified. An identity carries an
 * email only when it was verified, so this is `isEmailAllowed` without the
 * claims.
 */
export function mayOwn(
  user: AuthenticatedUser,
  allowedEmails: string[] | undefined,
): boolean {
  if (!allowedEmails) {
    return true;
  }
  return !!user.email && allowedEmails.includes(user.email);
}

/** What a token's claims say about who it speaks for, or null without a `sub`. */
export function identityFromClaims(claims: {
  [claim: string]: unknown;
}): AuthenticatedUser | null {
  const sub = typeof claims.sub === "string" ? claims.sub : null;
  if (!sub) {
    return null;
  }
  // Dropped, not refused: a person whose address is unverified can still sign
  // in wherever no list is asked, and is simply nobody's listed member.
  const email =
    typeof claims.email === "string" && claims.email_verified === true
      ? normalizeEmail(claims.email)
      : "";
  return { sub, ...(email ? { email } : {}) };
}

function createJwtVerifier(
  domain: string,
  audience: string | string[],
): (token: string) => Promise<AuthenticatedUser | null> {
  // An empty `audience` makes jwt.verify skip the check altogether, which would
  // accept a token minted for any application in the tenant. Refusing to build a
  // verifier that cannot check is the fail-closed reading, and it also gives the
  // non-empty list jsonwebtoken's own typing asks for.
  const audiences = (Array.isArray(audience) ? audience : [audience]).filter(
    Boolean,
  );
  if (!audiences.length) {
    throw new Error(
      "JWT authentication needs at least one accepted audience (AUTH0_AUDIENCE)",
    );
  }
  const expected = audiences as [string, ...string[]];

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
      jwt.verify(token, getSigningKey, { audience: expected }, (err, decoded) => {
        if (err || !decoded || typeof decoded === "string") {
          resolve(null);
          return;
        }
        resolve(identityFromClaims(decoded));
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
      identifyToken: async () => ({ sub: ANONYMOUS_SUB }),
      authorizeOwner: async () => ({ sub: ANONYMOUS_SUB }),
    };
  }

  const verify = createJwtVerifier(config.domain, config.audience);

  const identifyToken = async (
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

  const authorizeOwner = async (
    token: string | undefined | null,
  ): Promise<AuthenticatedUser | null> => {
    if (!token) {
      return null;
    }
    // A session token was minted for somebody who had passed the allowlist,
    // and carries no email to ask it of again.
    const opaque = options.resolveOpaqueToken?.(token);
    if (opaque) {
      return opaque;
    }
    const user = await verify(token);
    return user && mayOwn(user, config.allowedEmails) ? user : null;
  };

  return {
    middleware: (req, res, next) => {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        res.sendStatus(401);
        return;
      }
      void authorizeOwner(header.slice(7)).then((user) => {
        if (!user) {
          res.sendStatus(401);
          return;
        }
        req.authenticatedUser = user;
        next();
      });
    },
    identifyToken,
    authorizeOwner,
  };
}

export type { AllowedOrigins } from "./origins";

/**
 * True when the bind address is reachable only from the local machine. A
 * loopback bind keeps other machines out — nothing off-machine can connect —
 * which is why running without authentication is permitted there. It does not
 * keep out a page in a browser on this machine; origins.ts does.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.")
  );
}

/**
 * Cross-Site WebSocket Hijacking protection, for an upgrade that carries a
 * credential. Browsers always send an Origin header on the WS handshake, so a
 * mismatched one is a cross-site attempt and is rejected. Non-browser clients
 * (e.g. the coordinator) send no Origin; they are allowed through here and
 * gated by the token check instead.
 *
 * An upgrade that carries no credential is asked more of; see
 * `admitsWithoutCredential` in origins.ts.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowed: AllowedOrigins,
): boolean {
  if (origin === undefined) {
    return true;
  }
  return allowsOrigin(origin, allowed);
}
