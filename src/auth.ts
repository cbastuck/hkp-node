import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authenticatedUser?: { sub: string };
    }
  }
}

export type AuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

export function buildJwtMiddleware(
  domain: string,
  audience: string,
): AuthMiddleware {
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

  return function jwtMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      res.sendStatus(401);
      return;
    }

    const token = header.slice(7);
    jwt.verify(token, getSigningKey, { audience }, (err, decoded) => {
      if (err || !decoded || typeof decoded === "string") {
        res.sendStatus(401);
        return;
      }
      const sub = typeof decoded.sub === "string" ? decoded.sub : null;
      if (!sub) {
        res.sendStatus(401);
        return;
      }

      req.authenticatedUser = { sub };
      next();
    });
  };
}

export function createServerAuthMiddleware(): AuthMiddleware {
  const domain = process.env.AUTH0_DOMAIN;
  const audience = process.env.AUTH0_AUDIENCE;

  if (!domain || !audience) {
    console.warn(
      "[server] AUTH0_DOMAIN/AUTH0_AUDIENCE not set — running without auth (do not use in production)",
    );
    return function passthroughMiddleware(_req, _res, next) {
      next();
    };
  }

  return buildJwtMiddleware(domain, audience);
}
