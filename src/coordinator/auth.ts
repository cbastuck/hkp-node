import { Request, Response, NextFunction } from "express";
import { AuthConfig, AuthMiddleware, createAuthenticator } from "../auth";

export function createAuthMiddleware(config: AuthConfig): AuthMiddleware {
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

  return createAuthenticator(config).middleware;
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
