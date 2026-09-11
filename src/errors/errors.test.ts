import { describe, expect, it } from 'vitest';
import {
  ClientErrorCode,
  ConnectTimeoutError,
  isSuccessCode,
  NebulaGraphRemoteError,
  PoolExhaustedError,
  ServerErrorCode,
  SUCCESS_CODE,
} from './errors.js';

describe('error codes', () => {
  it('exposes the success code constant matching ServerErrorCode.SuccessfulCompletion', () => {
    expect(SUCCESS_CODE).toBe('00000');
    expect(ServerErrorCode.SuccessfulCompletion).toBe('00000');
  });

  it('isSuccessCode correctly distinguishes success from failure codes', () => {
    expect(isSuccessCode('00000')).toBe(true);
    expect(isSuccessCode('42001')).toBe(false);
  });

  it('has the expected 12 client error codes', () => {
    expect(Object.keys(ClientErrorCode)).toHaveLength(12);
    expect(ClientErrorCode.ConnUnavailable).toBe('99002');
  });

  it('has hundreds of server error codes ported from the reference SDK', () => {
    expect(Object.keys(ServerErrorCode).length).toBeGreaterThan(700);
  });
});

describe('error classes', () => {
  it('NebulaGraphRemoteError carries the server code and message', () => {
    const err = new NebulaGraphRemoteError('42001', 'syntax error');
    expect(err.code).toBe('42001');
    expect(err.message).toContain('syntax error');
    expect(err).toBeInstanceOf(Error);
  });

  it('ConnectTimeoutError uses the client CannotOpen/ConnConnectTimeout code family', () => {
    const err = new ConnectTimeoutError('127.0.0.1:9669', 3000);
    expect(err.code).toBe(ClientErrorCode.ConnConnectTimeout);
    expect(err.message).toContain('3000ms');
  });

  it('PoolExhaustedError reports the wait time in its message', () => {
    const err = new PoolExhaustedError(500);
    expect(err.message).toContain('500ms');
    expect(err.code).toBe(ClientErrorCode.WaitPoolTimeout);
  });
});
