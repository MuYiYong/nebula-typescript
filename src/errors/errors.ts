/**
 * Error type hierarchy for nebula-typescript.
 *
 * Two distinct error layers, mirroring the reference SDKs (see
 * findings-python.md section 7, findings-java.md section 5-6,
 * findings-go.md section 6):
 *
 *  1. Client-side errors (NebulaClientError and subclasses): connection
 *     failures, timeouts, TLS errors, decode failures, pool exhaustion —
 *     things that happen before or outside of a server response. These use
 *     `ClientErrorCode` (the 99xxx range).
 *
 *  2. Server-side errors (NebulaServerError / NebulaGraphRemoteError): a
 *     query executed but the server returned a non-"00000" GQLSTATUS status
 *     code. These use `ServerErrorCode`.
 */

import { ClientErrorCode } from './clientErrorCodes.generated.js';
import { ServerErrorCode } from './serverErrorCodes.generated.js';

export { ClientErrorCode, ServerErrorCode };

export const SUCCESS_CODE: string = ServerErrorCode.SuccessfulCompletion;

export function isSuccessCode(code: string): boolean {
  return code === SUCCESS_CODE;
}

/** Base class for all errors raised by this SDK. */
export abstract class NebulaError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Base class for client-side errors (connection, pool, decode, TLS, etc). */
export abstract class NebulaClientError extends NebulaError {}

export class AddressNotValidError extends NebulaClientError {
  readonly code = ClientErrorCode.AddressNotValid;
  constructor(address: string) {
    super(`invalid host address: ${address}`);
  }
}

export class ConnectionError extends NebulaClientError {
  readonly code = ClientErrorCode.CannotOpen;
  constructor(address: string, cause?: unknown) {
    super(`failed to open connection to ${address}${cause ? `: ${String(cause)}` : ''}`);
    if (cause instanceof Error) this.cause = cause;
  }
}

export class ConnectionUnavailableError extends NebulaClientError {
  readonly code = ClientErrorCode.ConnUnavailable;
  constructor(address: string, cause?: unknown) {
    super(`connection unavailable: ${address}${cause ? `: ${String(cause)}` : ''}`);
  }
}

export class ConnectTimeoutError extends NebulaClientError {
  readonly code = ClientErrorCode.ConnConnectTimeout;
  constructor(address: string, timeoutMs: number) {
    super(`connect to ${address} timed out after ${timeoutMs}ms`);
  }
}

export class RequestTimeoutError extends NebulaClientError {
  readonly code = ClientErrorCode.ConnRequestTimeout;
  constructor(address: string, timeoutMs: number) {
    super(`request to ${address} timed out after ${timeoutMs}ms`);
  }
}

export class ConnectionClosedError extends NebulaClientError {
  readonly code = ClientErrorCode.ConnIsClosed;
  constructor(address: string) {
    super(`connection to ${address} is closed`);
  }
}

export class PoolExhaustedError extends NebulaClientError {
  readonly code = ClientErrorCode.WaitPoolTimeout;
  constructor(waitMs: number) {
    super(`timed out waiting for an available connection from the pool after ${waitMs}ms`);
  }
}

export class IllegalArgumentError extends NebulaClientError {
  readonly code = ClientErrorCode.Illegal;
}

export class TypeAssertionError extends NebulaClientError {
  readonly code = ClientErrorCode.Type;
}

export class ClientInternalError extends NebulaClientError {
  readonly code = ClientErrorCode.ClientInternal;
}

export class TlsConfigError extends NebulaClientError {
  readonly code = ClientErrorCode.TlsError;
}

export class DecodeFailedError extends NebulaClientError {
  readonly code = ClientErrorCode.DecodeFailed;
}

export class AuthenticationError extends NebulaClientError {
  readonly code = ClientErrorCode.CannotOpen;
  constructor(message: string) {
    super(`authentication failed: ${message}`);
  }
}

/**
 * Raised when a query executes but the server returns a non-success
 * GQLSTATUS code. Mirrors nebula-python's `NebulaGraphRemoteError`
 * (findings-python.md section 7.2).
 */
export class NebulaGraphRemoteError extends NebulaError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[${code}]: ${message}`);
  }
}
