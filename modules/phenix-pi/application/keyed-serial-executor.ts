export class KeyedSerialExecutor<K> {
  private readonly tails = new Map<K, Promise<void>>();

  run<T>(key: K, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => next);
    this.tails.set(key, tail);

    return previous.then(operation).finally(() => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }
}
