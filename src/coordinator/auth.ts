import { Request, Response, NextFunction } from "express";
import {
  AuthConfig,
  AuthMiddleware,
  Authenticator,
  createAuthenticator,
} from "../auth";

/**
 * The check the owner's routes sit behind. `authenticator` is the server's
 * own when there is one to share, so a token is verified by one party.
 */
export function createAuthMiddleware(
  config: AuthConfig,
  authenticator?: Authenticator,
): AuthMiddleware {
  if (config.mode === "none") {
    // Development only: with no real identity available, trust the :username
    // path param as the authenticated subject. resolveServerAuthConfig() only
    // ever yields "none" for a local checkout that opted in via ALLOW_NO_AUTH.
    return function trustMiddleware(req, res, next) {
      const username = req.params.username as string | undefined;
      if (!username) {
        res.sendStatus(401);
        return;
      }
      req.authenticatedUser = { sub: username };
      next();
    };
  }

  return (authenticator ?? createAuthenticator(config)).middleware;
}

/**
 * The check a route sits behind that is open to anybody with a verified
 * identity, whether or not the server's allowlist names them — a member
 * asking which boards are shared with them.
 *
 * Such a route says who may do what by something of its own (a board's member
 * list), so this establishes only who is asking. Without authentication
 * nobody is anybody, and the route answers as it would to a stranger.
 */
export function createIdentifyMiddleware(
  config: AuthConfig,
  authenticator?: Authenticator,
): AuthMiddleware {
  if (config.mode === "none") {
    return function nobodyMiddleware(_req, _res, next) {
      next();
    };
  }
  const { identifyToken } = authenticator ?? createAuthenticator(config);
  return (req, res, next) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    void identifyToken(token).then((user) => {
      if (!user) {
        res.sendStatus(401);
        return;
      }
      req.authenticatedUser = user;
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
  if (user.sub !== req.params.username) {
    res.sendStatus(403);
    return;
  }
  next();
}
