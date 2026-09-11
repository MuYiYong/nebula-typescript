/**
 * TLS configuration for connecting to NebulaGraph over an encrypted channel.
 * Mirrors the reference SDKs' TLS options (findings-go.md section 1.4,
 * findings-java.md section 7): CA-based one-way TLS, optional mTLS via a
 * client cert/key pair, and an explicit insecure-skip-verify escape hatch
 * for testing only.
 */

export interface TlsOptions {
  /** PEM-encoded CA certificate bytes used to verify the server's certificate. */
  readonly ca?: Buffer;
  /** PEM-encoded client certificate (for mutual TLS). */
  readonly cert?: Buffer;
  /** PEM-encoded client private key (for mutual TLS). */
  readonly key?: Buffer;
  /**
   * Skips server certificate verification entirely. Dangerous — only use
   * for local testing against a server with a self-signed certificate.
   */
  readonly insecureSkipVerify?: boolean;
}
