import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authenticatedUser?: { sub: string; nickname: string };
    }
  }
}

type AuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

export function createAuthMiddleware(): AuthMiddleware {
  const domain = process.env.AUTH0_DOMAIN;
  const audience = process.env.AUTH0_AUDIENCE;

  if (!domain || !audience) {
    console.warn(
      "[coordinator] AUTH0_DOMAIN/AUTH0_AUDIENCE not set — running in trust mode (do not use in production)",
    );
    return function trustMiddleware(req, res, next) {
      const username = req.params.username as string | undefined;
      if (!username) {
        res.sendStatus(401);
        return;
      }
      req.authenticatedUser = { sub: username, nickname: username };
      next();
    };
  }

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

      const nickname =
        typeof decoded.nickname === "string" ? decoded.nickname : null;
      if (!nickname) {
        res.sendStatus(401);
        return;
      }

      req.authenticatedUser = { nickname, sub };
      next();
    });
  };
}

export function requireSelf(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const user = req.authenticatedUser;
  if (!user) {
    res.sendStatus(401);
    return;
  }
  // In trust mode sub equals the requested username (missing username is rejected above).
  // In JWT mode, sub must match the username param.
  if (user.nickname !== req.params.username) {
    res.sendStatus(403);
    return;
  }
  next();
}
