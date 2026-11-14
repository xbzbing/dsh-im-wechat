/**
 * 根会话识别。
 *
 * 宿主的事件与提问都是「每个会话」级别的：子代理（subagent）也会开会话、也会提问、
 * 也会申请授权。提醒只该发给主人自己的会话，否则一个并行子任务就能刷屏。
 *
 * 判定来源是宿主自己的定义：`agent.session.header.origin === 'subagent'` 表示子代理
 * （与 `dsh-user-questions` 的 `assertLiveRoot` 同源）。**不按 id 查根集合**——宿主
 * 0.2.1 起 `AgentRegistry` 只剩 `get`/`list`，旧的 `roots()` 已删除，按它判定会得到
 * 恒空集合，把全部提醒静默关掉。
 *
 * 同一份结构描述还声明了 Agent 上的会话模型入口（`model.select`）：宿主 `agents`
 * 是唯一能按会话 id 取回活着 Agent 的服务，独立模式钉模型走它（ADR-0025）。
 *
 * 两个语义不同的判据：
 * - `isRoot`（提问/长任务）：只排除**明确**是子代理的会话；拿不到来源时放行，宁可多
 *   提醒一条。
 * - `canApprove`（工具授权）：必须**确认**是根会话；拿不到来源时拒绝。授权是安全
 *   边界，缺省失败关闭（ADR-0023）。
 */

export interface HostAgentSession {
  readonly header?: { readonly origin?: unknown } | null;
}

/**
 * Agent 自己的模型选择：只往这个会话追加一条 `model/selection` 事件，不改 DSH 的
 * 全局默认模型（与 `sessionController.selectModel` 的区别见 ADR-0025）。
 */
export interface HostAgentModel {
  select?(selection: { provider: string; model: string }): void;
}

export interface HostAgent {
  readonly id?: unknown;
  readonly session?: HostAgentSession | null;
  readonly model?: HostAgentModel | null;
}

export interface HostAgents {
  get?(id: string): HostAgent | undefined;
  on?(event: string, listener: () => void, options?: unknown): unknown;
}

/** 会话来源：子代理 / 根会话 / 拿不到（服务缺席、形状不认识、查询抛错）。 */
type Origin = 'subagent' | 'root' | 'unknown';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function originOf(agent: unknown): Origin {
  const session = asRecord(asRecord(agent)?.session);
  const header = asRecord(session?.header);
  if (header === null) return 'unknown';
  return header.origin === 'subagent' ? 'subagent' : 'root';
}

export class RootAgents {
  #service: HostAgents | null = null;

  attach(service: HostAgents | null): void {
    this.#service = service;
  }

  /** 提醒类判据：明确是子代理才拒绝，拿不准时放行。 */
  isRoot(agent: unknown): boolean {
    return originOf(agent) !== 'subagent';
  }

  /** 授权类判据：必须确认是根会话，拿不准一律拒绝（失败关闭）。 */
  canApprove(agent: unknown): boolean {
    return originOf(agent) === 'root';
  }

  /** 只有会话 id 的场景（长任务事件）：按 id 取回会话再看来源。 */
  isRootSession(sessionId: string | null): boolean {
    if (sessionId === null || sessionId === '') return false;
    const service = this.#service;
    // 服务缺席时无从判断：长任务提醒按宽容处理（与旧行为一致）。
    if (service === null || typeof service.get !== 'function') return true;
    let agent: HostAgent | undefined;
    try {
      agent = service.get(sessionId);
    } catch {
      return true;
    }
    // 取不到会话（已销毁/不是 agent 会话）：不据此拦截提醒。
    if (agent === undefined) return true;
    return this.isRoot(agent);
  }
}
