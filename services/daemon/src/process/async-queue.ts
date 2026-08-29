interface AsyncQueueOptions<T> {
  maxItems?: number;
  maxBytes?: number;
  sizeOf?: (value: T) => number;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  private ended = false;
  private failure: Error | null = null;
  private bufferedBytes = 0;

  constructor(private readonly options: AsyncQueueOptions<T> = {}) {
    if (options.maxItems !== undefined && (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1)) {
      throw new Error("Async queue item limit is invalid");
    }
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) {
      throw new Error("Async queue byte limit is invalid");
    }
  }

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }
    const valueBytes = this.options.sizeOf?.(value) ?? 0;
    if (!Number.isSafeInteger(valueBytes) || valueBytes < 0) {
      this.fail(new Error("Async queue item size is invalid"));
      return;
    }
    if (
      (this.options.maxItems !== undefined && this.values.length >= this.options.maxItems) ||
      (this.options.maxBytes !== undefined && this.bufferedBytes + valueBytes > this.options.maxBytes)
    ) {
      this.fail(new Error("Provider event buffer limit exceeded"));
      return;
    }
    this.values.push(value);
    this.bufferedBytes += valueBytes;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    this.values.splice(0);
    this.bufferedBytes = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          this.bufferedBytes -= this.options.sizeOf?.(value) ?? 0;
          return Promise.resolve({ done: false, value });
        }
        if (this.failure !== null) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      }
    };
  }
}
