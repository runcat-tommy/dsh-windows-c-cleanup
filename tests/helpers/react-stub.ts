/**
 * 测试用的最小 React 替身。
 *
 * 只实现面板真正用到的部分（createElement / jsx-runtime 的 jsx / 五个 hook），
 * 目的是在没有浏览器的环境里把客户端组件**真的跑一遍首屏**，抓拼写、导入与字段错误。
 * 它不是 React 的替代品：不重渲染、不做调度，`useEffect` 只同步执行一次。
 */

export interface Element {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
  __isElement: true;
}

export const Fragment = Symbol('react.Fragment');

export function createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element {
  return { type, props: { ...(props ?? {}) }, children, __isElement: true };
}

/** react/jsx-runtime 的 jsx/jsxs：children 已经在 props 里 */
export function jsxImpl(type: unknown, props: Record<string, unknown> | null): Element {
  return createElement(type, props ?? {});
}

/** 面板里的 hook 调用顺序在一次渲染内固定，所以这里用简单的模块级槽位即可 */
const slots: unknown[] = [];
let cursor = 0;
export function resetHooks(): void {
  cursor = 0;
}

export function useState<T>(initial: T): [T, (next: T) => void] {
  const index = cursor++;
  if (!(index in slots)) slots[index] = initial;
  const setter = (next: T): void => {
    slots[index] = next;
  };
  return [slots[index] as T, setter];
}

export function useEffect(callback: () => (() => void) | void): void {
  cursor++;
  callback();
}

export function useCallback<T>(callback: T): T {
  cursor++;
  return callback;
}

export function useMemo<T>(factory: () => T): T {
  cursor++;
  return factory();
}

export function useRef<T>(initial: T): { current: T } {
  cursor++;
  return { current: initial };
}

export const reactStub = { useState, useEffect, useCallback, useMemo, useRef };
