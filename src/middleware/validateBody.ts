import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';

export const validateBody =
  (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: parsed.error.flatten()
      });
      return;
    }
    // Replace body with parsed data (with defaults applied)
    req.body = parsed.data;
    next();
  };
