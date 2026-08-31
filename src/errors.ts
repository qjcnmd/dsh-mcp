export type ErrorDetails = Record<string, unknown>;

/** Base error type for adapter failures that are not valid DSH domain results. */
export class DshMcpError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(code: string, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'DshMcpError';
    this.code = code;
    this.details = details;
  }
}

export class DshTransportError extends DshMcpError {
  readonly status: number | null;

  constructor(message: string, status: number | null = null, details: ErrorDetails = {}) {
    super('transport-error', message, details);
    this.name = 'DshTransportError';
    this.status = status;
  }
}

export class DshProtocolError extends DshMcpError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('protocol-error', message, details);
    this.name = 'DshProtocolError';
  }
}

export class DshDomainError extends DshMcpError {
  readonly dshCode: string;

  constructor(dshCode: string, message: string, details: ErrorDetails = {}) {
    super('dsh-domain-error', message, { dshCode, ...details });
    this.name = 'DshDomainError';
    this.dshCode = dshCode;
  }
}

export class UnsupportedCapabilityError extends DshMcpError {
  constructor(capabilityId: string, message = `Capability ${capabilityId} is not available through the structured DSH contract`) {
    super('unsupported-capability', message, { capabilityId });
    this.name = 'UnsupportedCapabilityError';
  }
}

export class InvalidTargetError extends DshMcpError {
  constructor(field: string, message = `${field} is required and must be a non-blank identifier`) {
    super('invalid-target', message, { field });
    this.name = 'InvalidTargetError';
  }
}

export interface DshRpcErrorBody {
  code: string;
  message: string;
  details?: ErrorDetails;
}

export function toDshDomainError(error: DshRpcErrorBody): DshDomainError {
  return new DshDomainError(error.code, error.message, error.details);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
