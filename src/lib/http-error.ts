/** Shared status error without server/database imports (also used by the local companion). */
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
