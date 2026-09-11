/**
 * Client-side error codes, ported verbatim from nebula-go's pkg/errors/error.go
 * (ERROR_* constants in the 99xxx range). Auto-generated; do not hand-edit.
 */

export const ClientErrorCode = {
  AddressNotValid: "99000",
  CannotOpen: "99001",
  ConnUnavailable: "99002",
  ConnConnectTimeout: "99003",
  ConnRequestTimeout: "99004",
  ConnIsClosed: "99005",
  WaitPoolTimeout: "99006",
  Illegal: "99007",
  Type: "99008",
  ClientInternal: "99009",
  TlsError: "99010",
  DecodeFailed: "99011",
} as const;

export type ClientErrorCode = (typeof ClientErrorCode)[keyof typeof ClientErrorCode];
