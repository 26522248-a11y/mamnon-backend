import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
  409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 422: 'UNPROCESSABLE', 429: 'TOO_MANY_REQUESTS', 503: 'SERVICE_UNAVAILABLE',
};

/** Throw this to control the `code` field explicitly. */
export class AppError extends HttpException {
  /** details -> body.details; extra -> merged into the top level of the body (e.g. lockedUntil). */
  constructor(status: number, public readonly code: string, message: string, public readonly details?: unknown, public readonly extra?: Record<string, unknown>) {
    super({ code, message }, status);
  }
}
export const Forbidden = (msg = 'Không có quyền truy cập tài nguyên này') => new AppError(403, 'FORBIDDEN', msg);
export const NotFound = (msg = 'Không tìm thấy') => new AppError(404, 'NOT_FOUND', msg);
export const BadRequest = (msg: string, code = 'BAD_REQUEST') => new AppError(400, code, msg);

/** All errors leave the API as { code, message } (+ optional details). */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: { code: string; message: string; details?: unknown; [k: string]: unknown } = { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống' };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r: any = exception.getResponse();
      if (exception instanceof AppError) body = { code: exception.code, message: r.message, ...(exception.extra ?? {}), ...(exception.details !== undefined ? { details: exception.details } : {}) };
      else if (status === 400 && Array.isArray(r?.message)) body = { code: 'VALIDATION_ERROR', message: 'Dữ liệu không hợp lệ', details: r.message };
      else if (status === 413) body = { code: 'PAYLOAD_TOO_LARGE', message: 'File quá lớn so với giới hạn cho phép' }; // multer "File too large"
      else body = { code: CODE_BY_STATUS[status] ?? 'ERROR', message: typeof r === 'string' ? r : (Array.isArray(r?.message) ? r.message.join('; ') : r?.message ?? exception.message) };
    } else if (exception instanceof QueryFailedError) {
      const pg: any = (exception as any).driverError;
      if (pg?.code === '23505') { status = 409; body = { code: 'CONFLICT', message: 'Dữ liệu bị trùng' }; }
      else if (pg?.code === '23503') { status = 400; body = { code: 'INVALID_REFERENCE', message: 'Tham chiếu không tồn tại' }; }
      else if (pg?.code === '22P02') { status = 400; body = { code: 'BAD_REQUEST', message: 'ID không hợp lệ' }; }
      else this.logger.error(exception);
    } else {
      this.logger.error(exception);
    }
    if ((exception as any)?.retryAfter) res.setHeader('Retry-After', String((exception as any).retryAfter));
    res.status(status).json(body);
  }
}
