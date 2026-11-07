/**
 * 根会话识别。
 *
 * 宿主的事件与提问都是「每个会话」级别的：子代理（subagent）也会开会话、也会提问。
 * 提醒只该发给主人自己的会话，否则一个并行子任务就能刷屏。
 *
 * 判定来源是 `agents` 服务：`agents.roots()` 是根会话，`agents.get(id)` 按会话 id 取。
 * 服务缺席时（没有 agents 的组合）**按根会话处理**——宁可多提醒一条，也不要因为
 * 拿不到服务就永远不提醒。
 */

export interface HostAgent {
  readonly id?: unknown;
}

export interface HostAgents {
  roots?(): HostAgent[];
  get?(id: string): HostAgent | undefined;
  on?(event: string, listener: () => void, options?: unknown): unknown;
}

export class RootAgents {
  #service: HostAgents | null = null;
  #roots = new Set<string>();
  /** 服务存在但读不出根集合：这时无法判断，按「全部是根会话」放行。 */
  #unusable = false;

  attach(service: HostAgents | null): void {
    this.#service = service;
    this.refresh();
  }

  /** 服务就绪、agent 创建/销毁时重算根集合。 */
  refresh(): void {
    const next = new Set<string>();
    try {
      for (const agent of this.#service?.roots?.() ?? []) {
        if (typeof agent?.id === 'string') next.add(agent.id);
      }
      this.#unusable = false;
    } catch {
      // 服务实现异常不该让插件起不来：退化成「全部当根会话」，宁可多提醒。
      this.#unusable = true;
      this.#roots = next;
      return;
    }
    this.#roots = next;
  }

  /** 未知服务时返回 true（放行）；已知服务时按根集合判断。 */
  isRoot(sessionId: string | null): boolean {
    if (this.#service === null || this.#unusable) return true;
    if (sessionId === null || sessionId === '') return false;
    return this.#roots.has(sessionId);
  }

  get known(): boolean {
    return this.#service !== null;
  }

  get size(): number {
    return this.#roots.size;
  }
}
