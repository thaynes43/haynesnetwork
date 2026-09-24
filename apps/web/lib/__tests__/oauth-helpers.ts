// Test helpers for the OAuth route / page tests (web tests never touch a database — the packages are mocked).
import { isValidElement, type ReactElement, type ReactNode } from 'react';

/** Every element in a server-component tree (function components are NOT rendered — their props are inspected). */
export function elements(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  const visit = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (!isValidElement(n)) return;
    out.push(n);
    const props = n.props as { children?: ReactNode };
    visit(props.children);
  };
  visit(node);
  return out;
}

const BLOCKS = new Set(['h1', 'h2', 'p', 'li', 'ul', 'button', 'section', 'div', 'form']);

/** The text of a tree (strings and numbers, depth-first; block elements separated), whitespace-collapsed. */
export function textOf(node: ReactNode): string {
  const parts: string[] = [];
  const visit = (n: ReactNode): void => {
    if (typeof n === 'string' || typeof n === 'number') parts.push(String(n));
    else if (Array.isArray(n)) n.forEach(visit);
    else if (isValidElement(n)) {
      const block = typeof n.type === 'string' && BLOCKS.has(n.type);
      if (block) parts.push(' ');
      visit((n.props as { children?: ReactNode }).children);
      if (block) parts.push(' ');
    }
  };
  visit(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** Expand function components whose names are given (server components render synchronously here). */
export function expand(node: ReactNode, names: string[]): ReactNode {
  if (Array.isArray(node)) return node.map((n) => expand(n, names));
  if (!isValidElement(node)) return node;
  const type = node.type as { name?: string } | string;
  if (typeof type === 'function' && names.includes((type as { name: string }).name)) {
    return expand((type as (p: unknown) => ReactNode)(node.props), names);
  }
  const props = node.props as { children?: ReactNode };
  if (props.children === undefined) return node;
  return { ...node, props: { ...props, children: expand(props.children, names) } } as ReactElement;
}

/** A thrown `redirect()` from a mocked next/navigation. */
export class RedirectSignal extends Error {
  constructor(readonly location: string) {
    super(`redirect → ${location}`);
  }
}

export const form = (body: string) => ({
  'content-type': 'application/x-www-form-urlencoded',
  body,
});
