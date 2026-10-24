type DisposableFn = () => Promise<void>;
type DisposableObject = { dispose(): Promise<void> };

export type Disposable = DisposableFn | DisposableObject;
