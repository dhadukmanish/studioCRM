export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const notFound = (what = 'The requested resource') => new AppError('NOT_FOUND', `${what} was not found`, 404);
export const forbidden = (msg = 'You do not have permission to perform this action') => new AppError('FORBIDDEN', msg, 403);
export const validation = (msg: string, details?: unknown) => new AppError('VAL_001', msg, 400, details);
