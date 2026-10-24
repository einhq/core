/**
 * Node-specific errors
 */

export class NodeError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'NodeError';
  }
}

export class NodeNotFoundError extends NodeError {
  constructor(nodeId: string) {
    super(`Node not found: ${nodeId}`, 'NODE_NOT_FOUND');
    this.name = 'NodeNotFoundError';
  }
}

export class NodeAccessDeniedError extends NodeError {
  constructor(nodeId: string, operation: string) {
    super(
      `Access denied for operation '${operation}' on node: ${nodeId}`,
      'NODE_ACCESS_DENIED',
    );
    this.name = 'NodeAccessDeniedError';
  }
}

export class NodeAlreadyExistsError extends NodeError {
  constructor(parentId: string, name: string) {
    super(
      `Node already exists in parent ${parentId} with name: ${name}`,
      'NODE_ALREADY_EXISTS',
    );
    this.name = 'NodeAlreadyExistsError';
  }
}

export class NodeInvalidOperationError extends NodeError {
  constructor(message: string) {
    super(message, 'NODE_INVALID_OPERATION');
    this.name = 'NodeInvalidOperationError';
  }
}

export class NodeTransactionError extends NodeError {
  constructor(message: string) {
    super(message, 'NODE_TRANSACTION_ERROR');
    this.name = 'NodeTransactionError';
  }
}

export class NodeVersionConflictError extends NodeError {
  constructor(nodeId: string) {
    super(`version conflict for node ${nodeId}: it was changed by another write`, 'NODE_VERSION_CONFLICT');
    this.name = 'NodeVersionConflictError';
  }
}

export class NodeNotSupportedError extends NodeError {
  constructor(message: string) {
    super(message, 'NODE_NOT_SUPPORTED');
    this.name = 'NodeNotSupportedError';
  }
}

export class NodeFrozenError extends NodeError {
  constructor(nodeId: string) {
    super(`File is frozen and cannot be modified: ${nodeId}`, 'NODE_FROZEN');
    this.name = 'NodeFrozenError';
  }
}

export class NodeReadonlyError extends NodeError {
  constructor(path: string) {
    super(`read-only mount, cannot modify: ${path}`, 'NODE_READONLY');
    this.name = 'NodeReadonlyError';
  }
}

export class NodeBusyError extends NodeError {
  constructor(path: string) {
    super(`a filesystem is mounted at ${path}`, 'NODE_BUSY');
    this.name = 'NodeBusyError';
  }
}

export class NodeTierImmutableError extends NodeError {
  constructor(nodeId: string) {
    super(`storage tier is set once at creation and cannot be changed: ${nodeId}`, 'NODE_TIER_IMMUTABLE');
    this.name = 'NodeTierImmutableError';
  }
}
