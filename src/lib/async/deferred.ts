export interface Deferred<T> extends Promise<T> {
  resolve(value?: T | PromiseLike<T>): void;
  reject(reason?: any): void;
  isResolved(): boolean;
  isRejected(): boolean;
  isFinished(): boolean;
}

export function deferred<T>(): Deferred<T> {
  let state = 'pending'; // 'pending', 'resolved', or 'rejected'
  const { promise, resolve, reject } = Promise.withResolvers();

  const resolveWrapper = (value?: T | PromiseLike<T>): void => {
    state = 'resolved';
    resolve(value);
  };

  const rejectWrapper = (reason?: any): void => {
    state = 'rejected';
    reject(reason);
  };

  const isResolved = (): boolean => state === 'resolved';
  const isRejected = (): boolean => state === 'rejected';
  const isFinished = (): boolean => state === 'resolved' || state === 'rejected';

  return Object.assign(promise, {
    resolve: resolveWrapper,
    reject: rejectWrapper,
    isResolved,
    isRejected,
    isFinished,
  }) as Deferred<T>;
}
