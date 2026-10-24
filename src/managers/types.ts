export interface ManagerIf {
  init(): Promise<void>;
  dispose(): Promise<void>;
}
