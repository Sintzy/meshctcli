// Error types and process exit codes used across MeshCLI.

export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,      // generic failure
  USAGE: 2,      // invalid arguments
  AUTH: 3,       // authentication / authorization failure
  NOT_FOUND: 4,  // device not found or ambiguous
  NETWORK: 5,    // connection, TLS or timeout problem
  OFFLINE: 6,    // device agent not connected
  CANCELLED: 130 // user cancelled (Ctrl+C / Esc / declined confirmation)
});

export class MeshError extends Error {
  /**
   * @param {string} message  Human readable message (English).
   * @param {{exitCode?: number, hint?: string, details?: string[], cause?: unknown}} [opts]
   */
  constructor(message, { exitCode = EXIT.ERROR, hint, details, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MeshError';
    this.exitCode = exitCode;
    this.hint = hint;
    this.details = details;
  }
}

export class UsageError extends MeshError {
  constructor(message, opts = {}) { super(message, { exitCode: EXIT.USAGE, ...opts }); this.name = 'UsageError'; }
}

export class AuthError extends MeshError {
  /** @param {string} message @param {{reason?: string, info?: object} & object} [opts] */
  constructor(message, { reason, info, ...opts } = {}) {
    super(message, { exitCode: EXIT.AUTH, ...opts });
    this.name = 'AuthError';
    this.reason = reason;   // 'invalid' | 'tokenrequired' | 'locked' | 'banned' | 'notools' | 'nokey' | 'emailvalidation' | 'nocredentials'
    this.info = info || {}; // raw server fields such as email2fa, sms2fa
  }
}

export class NetworkError extends MeshError {
  constructor(message, opts = {}) { super(message, { exitCode: EXIT.NETWORK, ...opts }); this.name = 'NetworkError'; }
}

export class CancelledError extends MeshError {
  constructor(message = 'Operation cancelled.') { super(message, { exitCode: EXIT.CANCELLED }); this.name = 'CancelledError'; }
}
