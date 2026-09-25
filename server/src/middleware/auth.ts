import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface AdminClaims {
  sub: number;
  email: string;
  name: string;
  kind: 'admin';
}

declare global {
  namespace Express {
    interface Request {
      admin?: AdminClaims;
    }
  }
}

export function signAdminToken(claims: Omit<AdminClaims, 'kind'>) {
  return jwt.sign({ ...claims, kind: 'admin' }, config.jwtSecret, { expiresIn: '12h' });
}

/** Verify the Bearer token, if any. Returns the payload or null. */
function verifyBearer(req: Request): any | null {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const payload = verifyBearer(req);
  if (!payload || payload.kind !== 'admin') {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.admin = payload as AdminClaims;
  next();
}
