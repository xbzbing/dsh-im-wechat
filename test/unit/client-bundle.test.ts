import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

/**
 * 客户端产物的冒烟测试。
 *
 * 面板白屏是两半式插件最难从日志反推的故障（宿主只报「模块加载失败」）。这里
 * 把 `lib/client.js` 按宿主的加载协议跑一遍：用假的 `window.__ModuleLoader__`
 * 拿到工厂、用假的 `require` 提供平台模块，然后真的调一次 `apply`，确认两个
 * 槽位都注册了、组件是函数。
 *
 * 依赖 `npm run build` 先产出 `lib/client.js`（`npm test` 已经保证）。
 */

interface SlotRegistration {
  name: string;
  spec: any;
  component: unknown;
}

function loadClientBundle(options: { locale?: boolean } = {}): {
  apply: (ctx: any) => void;
  name: string;
  inject: readonly string[];
  registrations: SlotRegistration[];
  localeNamespaces: string[];
} {
  const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');

  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState: (initial: unknown) => [initial, () => undefined],
    useEffect: () => undefined,
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useRef: (value: unknown) => ({ current: value }),
  };
  const fakeRequire = (spec: string) => {
    if (spec === 'react') return react;
    throw new Error(`未预期的平台模块：${spec}`);
  };

  let definition: { id: string; factory: (require: (spec: string) => unknown) => any } | null = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (value: typeof definition) => { definition = value; } } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Request,
    Response,
    AbortSignal,
  };
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' });

  assert.ok(definition, 'client.js 没有注册模块加载器工厂');
  assert.equal((definition as { id: string }).id, 'dsh-im-wechat');

  const exports = (definition as { factory: (require: (spec: string) => unknown) => any })
    .factory(fakeRequire);

  const registrations: SlotRegistration[] = [];
  const localeNamespaces: string[] = [];
  const ctx = {
    effect: (execute: () => unknown) => execute(),
    ...(options.locale === false ? {} : {
      locale: {
        register: (namespace: string) => {
          localeNamespaces.push(namespace);
          return () => undefined;
        },
        bind: () => (key: string) => key,
      },
    }),
    connection: { rpc: { call: async () => ({ result: { ok: true, value: {} } }) } },
    slots: {
      inject: (_name: string, install: () => unknown) => install(),
      register: (spec: any, component: unknown) => {
        registrations.push({ name: spec.name, spec, component });
        return () => undefined;
      },
    },
  };
  exports.apply(ctx);

  return {
    apply: exports.apply,
    name: exports.name,
    inject: exports.inject ?? [],
    registrations,
    localeNamespaces,
  };
}

test('客户端产物可按宿主的加载协议载入并注册', () => {
  const loaded = loadClientBundle();
  assert.equal(loaded.name, 'dsh-im-wechat');
  assert.deepEqual(loaded.localeNamespaces, ['dsh-im-wechat']);
  assert.deepEqual(
    loaded.registrations.map((item) => item.name),
    ['settings.section', 'plugins.bundle.config'],
  );
  for (const registration of loaded.registrations) {
    assert.equal(typeof registration.component, 'function');
    assert.equal(registration.spec.locale, 'dsh-im-wechat');
    const dependencies = registration.spec.inject();
    assert.equal(typeof dependencies.t, 'function');
    assert.equal(typeof dependencies.rpcCall, 'function');
  }
  assert.equal(loaded.registrations[1].spec.key, 'dsh-im-wechat');
});

test('缺少文案服务时回落到中文字典，不把键名露给用户', () => {
  const loaded = loadClientBundle({ locale: false });
  for (const registration of loaded.registrations) {
    const dependencies = registration.spec.inject();
    assert.equal(dependencies.t('panel.title'), '微信');
    assert.equal(dependencies.t('login.phase.waiting'), '等待扫码');
    assert.equal(dependencies.t('reminder.invalid', { min: 1, max: 1440 }), '阈值需为 1 到 1440 的整数分钟');
  }
});

test('缺少槽位与文案服务时安静降级，不抛', () => {
  const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
  let definition: { factory: (require: (spec: string) => unknown) => any } | null = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (value: typeof definition) => { definition = value; } } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Request,
    Response,
    AbortSignal,
  };
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' });
  const exports = (definition as { factory: (require: (spec: string) => unknown) => any } | null)
    ?.factory(() => ({ createElement: () => null }));
  assert.ok(exports);
  assert.doesNotThrow(() => exports.apply({ effect: (execute: () => unknown) => execute() }));
});
