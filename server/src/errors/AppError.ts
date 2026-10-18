export class AppError extends Error {
  readonly statusCode: number;
  readonly publicMessage: string;

  constructor(statusCode: number, publicMessage: string) {
    super(publicMessage);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(publicMessage: string) {
    super(400, publicMessage);
  }
}

export class UnauthorizedError extends AppError {
  constructor(publicMessage = '認証が必要です') {
    super(401, publicMessage);
  }
}

export class ForbiddenError extends AppError {
  constructor(publicMessage = 'この操作を行う権限がありません') {
    super(403, publicMessage);
  }
}

export class NotFoundError extends AppError {
  constructor(publicMessage = 'リソースが見つかりません') {
    super(404, publicMessage);
  }
}

export class ConflictError extends AppError {
  constructor(publicMessage: string) {
    super(409, publicMessage);
  }
}
