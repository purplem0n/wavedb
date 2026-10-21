export type WaveErrorCode =
  | "WAVE_STORAGE"
  | "WAVE_CONFLICT"
  | "WAVE_SQL"
  | "WAVE_CONSTRAINT"
  | "WAVE_NOT_FOUND"
  | "WAVE_INVALID"
  | "WAVE_CLOSED"
  | "WAVE_NETWORK"
  | "WAVE_UNKNOWN";

/** Base class of every error thrown by WaveDB. */
export class WaveError extends Error {
  readonly code: WaveErrorCode;
  constructor(message: string, code: WaveErrorCode = "WAVE_UNKNOWN") {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Another transaction committed a conflicting change first. `db.tx()` retries these automatically. */
export class ConflictError extends WaveError {
  constructor(message: string) {
    super(message, "WAVE_CONFLICT");
  }
}
/** UNIQUE / NOT NULL / type violation. */
export class ConstraintError extends WaveError {
  constructor(message: string) {
    super(message, "WAVE_CONSTRAINT");
  }
}
export class SqlError extends WaveError {
  constructor(message: string) {
    super(message, "WAVE_SQL");
  }
}
export class NotFoundError extends WaveError {
  constructor(message: string) {
    super(message, "WAVE_NOT_FOUND");
  }
}
export class ClosedError extends WaveError {
  constructor(message: string) {
    super(message, "WAVE_CLOSED");
  }
}

const PREFIX = /^(WAVE_[A-Z_]+): ([\s\S]*)$/;

/** Maps the `WAVE_CODE: message` errors thrown by the native layer to typed errors. */
export function mapNativeError(e: unknown): Error {
  if (e instanceof WaveError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const m = PREFIX.exec(msg);
  if (!m) return e instanceof Error ? e : new WaveError(msg);
  const [, code, rest] = m as unknown as [string, WaveErrorCode, string];
  const clean = rest.replace(/^(transaction conflict|constraint violation|sql error|not found|invalid|storage error): /, (s) => (code === "WAVE_CONFLICT" ? s : ""));
  switch (code) {
    case "WAVE_CONFLICT":
      return new ConflictError(clean);
    case "WAVE_CONSTRAINT":
      return new ConstraintError(clean);
    case "WAVE_SQL":
      return new SqlError(clean);
    case "WAVE_NOT_FOUND":
      return new NotFoundError(clean);
    case "WAVE_CLOSED":
      return new ClosedError(clean);
    default:
      return new WaveError(clean, code);
  }
}
