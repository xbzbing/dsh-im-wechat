/**
 * 提问与审批共用的机械件。
 *
 * 两个 broker 的「等待窗口 + 与 Web 竞速 + 待答表 + 上限收口」骨架几乎一样，
 * 差别只在结局映射与词表。这里只放与语义无关的部分：`deferred`、abort 监听、
 * 取消原因、待答表；结局怎么映射仍由各自 broker 决定。
 */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** 一个信号 abort 时 resolve（不 reject，便于直接参与 race）。 */
export function whenAborted(signal: AbortSignal | undefined): { promise: Promise<void>; dispose(): void } {
  let dispose = (): void => {};
  const promise = new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    dispose = () => signal.removeEventListener('abort', onAbort);
  });
  return { promise, dispose };
}

export interface AbortReasonOptions {
  name?: string;
  code?: string;
}

/** 带 name/code 的取消原因：宿主按 code 区分「用户取消」与别的失败。 */
export function abortReason(message: string, options: AbortReasonOptions = {}): Error {
  const error = new Error(message);
  error.name = options.name ?? 'UserQuestionError';
  (error as { code?: string }).code = options.code ?? 'ASK_ABORTED';
  return error;
}

export interface PendingEntry {
  readonly id: string;
}

/**
 * 待答表：插入顺序就是新旧顺序，上限在插入之后收口。
 *
 * `sweep()` 返回被挤掉的条目而不是自己结算——提问要 abort 本地信号，审批要交回
 * Web，两者的收尾方式不同，表本身不该知道。
 */
export class PendingTable<T extends PendingEntry> {
  readonly #max: number;
  readonly #entries = new Map<string, T>();

  constructor(max: number) {
    this.#max = max;
  }

  get size(): number {
    return this.#entries.size;
  }

  add(entry: T): void {
    this.#entries.set(entry.id, entry);
  }

  delete(id: string): void {
    this.#entries.delete(id);
  }

  clear(): void {
    this.#entries.clear();
  }

  values(): IterableIterator<T> {
    return this.#entries.values();
  }

  /** 最新的一条（主人看到的是最近发出的提醒）。 */
  newest(): T | undefined {
    let last: T | undefined;
    for (const entry of this.#entries.values()) last = entry;
    return last;
  }

  /** 新→旧：认领时先试最近的一条。 */
  newestFirst(): T[] {
    return [...this.#entries.values()].reverse();
  }

  /** 超出上限时挤掉最旧的，返回被挤掉的条目（最旧在前）。 */
  sweep(): T[] {
    const dropped: T[] = [];
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      const entry = this.#entries.get(oldest.value);
      this.#entries.delete(oldest.value);
      if (entry !== undefined) dropped.push(entry);
    }
    return dropped;
  }
}
