/**
 * 面板的宿主共享模块与渲染原语。
 *
 * 打包产物是单个无 import 的脚本（`lib/client.js`）：平台模块（`react`、
 * `@deepseek-ai/*`）由宿主的模块表注入，这里只从 `require` 取。
 *
 * 面板没有 JSX（tsconfig 未开 `jsx`），统一用 `createElement`；签名放宽是因为
 * props 大量来自宿主返回的松散对象，过度建模只会增加维护成本。
 */

import * as React from 'react';

export const { useCallback, useEffect, useMemo, useRef, useState } = React;

export const h = React.createElement as unknown as (
  type: any,
  props?: any,
  ...children: any[]
) => any;

/** 取宿主模块表里的模块；取不到返回 null，面板降级而不是白屏。 */
export function optionalRequire(name: string): any {
  try {
    return require(name);
  } catch {
    return null;
  }
}
