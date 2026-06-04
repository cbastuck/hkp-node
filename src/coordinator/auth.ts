import { Request, Response, NextFunction } from "express";
import { AuthMiddleware, buildJwtMiddleware } from "../auth";

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
      req.authenticatedUser = { sub: username };
      next();
    };
  }

  return buildJwtMiddleware(domain, audience);
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
