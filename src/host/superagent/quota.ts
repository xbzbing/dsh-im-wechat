/**
 * 平台主动消息的发送节奏（bridge 级共享）。
 *
 * `capabilities.quotas` 声明的是 bot 级窗口：图片与文字、不同交付都在同一个账本里。
 * 核心按交付调用 `deliver`，看不到桥内部的分条与图片扇出，所以窗口只能由桥自己执行。
 *
 * 占位是串行的：并发交付不能同时读到同一个空位。但只串行「等窗口 + 记一笔」，
 * 不串行整次发送——否则第二条交付会无谓地排到第一条后面。
 */

export interface SendQuotaOptions {
  max: number;
  windowMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class SendQuota {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** 当前窗口内已占用的发送时刻，按时间升序。 */
  #marks: number[] = [];
  /** 串行队列：保证并发调用不会一起越过上限。 */
  #tail: Promise<void> = Promise.resolve();

  constructor(options: SendQuotaOptions) {
    this.#max = options.max;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** 占一条消息的名额；窗口已满时等到最早一条滑出再返回。 */
  async take(): Promise<void> {
    const task = this.#tail.then(() => this.#takeOnce());
    // 队列只关心顺序；上一次失败不能在链上留下未处理的拒绝。
    this.#tail = task.catch(() => undefined);
    return task;
  }

  async #takeOnce(): Promise<void> {
    for (;;) {
      const now = this.#now();
      while (this.#marks.length > 0 && now - this.#marks[0]! >= this.#windowMs) this.#marks.shift();
      if (this.#marks.length < this.#max) {
        this.#marks.push(now);
        return;
      }
      await this.#sleep(this.#windowMs - (now - this.#marks[0]!));
    }
  }
}
