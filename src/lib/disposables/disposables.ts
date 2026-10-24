import { createLogger } from '../../managers/logger/mod.ts';
import { Disposable } from './types.ts';

const logger = createLogger('disposables');

export class Disposables {
  private disposables: Disposable[] = [];

  async dispose() {
    const disposables = this.disposables.reverse();

    for (const disposable of disposables) {
      await this.runDisposable(disposable);
    }

    this.disposables = [];
  }

  private async runDisposable(disposable: Disposable) {
    try {
      if (typeof disposable === 'function') {
        await disposable();
      } else if (disposable?.dispose) {
        await disposable.dispose();
      }
    } catch (error) {
      logger.error('Failed to cleanup disposable', error);
    }
  }

  public addDisposable(disposeFn: Disposable) {
    this.disposables.push(disposeFn);
  }
}
