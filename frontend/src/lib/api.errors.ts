export class ApiError extends Error {
  status: number;
  kind: string;
  constructor(status: number, kind: string, message: string) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}
