/**
 * 保住 64 位消息 id 的 JSON 解析。
 *
 * `WeixinMessage.message_id` 与 `WeixinItem.msg_id` 是 64 位整数。直接用
 * `JSON.parse` 会先转成 double，超过 `Number.MAX_SAFE_INTEGER` 时静默取整：
 * 两条不同的消息于是有了同一个 id，去重和回复上下文都会错位。
 *
 * 三段处理：
 * 1. 运行时支持 JSON source 访问（Node ≥ 21）时，用原始文本还原精确值；
 * 2. 不支持时退化成字符串化，至少不会把已经取整的数值再当数字用；
 * 3. 其余键原样返回。
 */

/** 需要保真的键：都在 iLink 的消息形状里，且都可能是 64 位整数。 */
const INTEGER_KEYS = new Set(['message_id', 'msg_id']);

/** `JSON.parse` 的 reviver 第三参数（JSON source access）；老运行时不会传。 */
interface ReviverContext {
  source?: string;
}

type Reviver = (this: unknown, key: string, value: unknown, context?: ReviverContext) => unknown;

/** 协议允许十进制整数，含负号；`-0` 归一成 `0`。 */
const DECIMAL_INTEGER = /^-?\d+$/;

export function parseJsonKeepIntegers(text: string): unknown {
  const reviver: Reviver = (key, value, context) => {
    if (typeof value !== 'number' || !INTEGER_KEYS.has(key)) return value;
    const source = context?.source;
    if (typeof source === 'string' && DECIMAL_INTEGER.test(source)) {
      return source === '-0' ? '0' : source;
    }
    return String(value);
  };
  // 运行时给出的 reviver 签名随版本不同，这里按我们需要的形状调用。
  const parse = JSON.parse as (input: string, reviver: Reviver) => unknown;
  return parse(text, reviver);
}
