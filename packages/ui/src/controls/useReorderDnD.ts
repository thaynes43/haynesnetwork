'use client';

// Generic native-HTML5 drag-and-drop reorder hook (ADR-015, DESIGN-004),
// ported from demo-console's dependency-free mechanism. Whole rows drag; a
// grip glyph doubles as a keyboard handle (arrow keys). No dependencies, no
// pointer polyfills — just HTML5 drag events + geometry from reorder.ts.
import { useState } from 'react';
import type {
  DragEvent,
  DragEventHandler,
  KeyboardEvent,
  KeyboardEventHandler,
} from 'react';
import { computeDropIndex, resolveReorderIndex } from './reorder';

export interface UseReorderDnDOptions {
  ids: string[];
  onReorder: (fromId: string, toIndex: number) => void;
  disabled?: boolean;
}

export interface ReorderContainerProps {
  onDragOver: DragEventHandler;
  onDrop: DragEventHandler;
  onDragLeave: DragEventHandler;
}

export interface ReorderRowProps {
  draggable: boolean;
  'data-line-row': number;
  onDragStart: DragEventHandler;
  onDragEnd: DragEventHandler;
}

export interface ReorderHandleProps {
  'aria-keyshortcuts': string;
  onKeyDown: KeyboardEventHandler;
}

export interface UseReorderDnD {
  containerProps: ReorderContainerProps;
  rowProps: (id: string, index: number) => ReorderRowProps;
  handleProps: (id: string, index: number) => ReorderHandleProps;
  isDragging: (id: string) => boolean;
  showBefore: (index: number) => boolean;
  showAtEnd: () => boolean;
}

export function useReorderDnD({
  ids,
  onReorder,
  disabled,
}: UseReorderDnDOptions): UseReorderDnD {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const clear = () => {
    setDragId(null);
    setDropIndex(null);
  };

  const containerProps: ReorderContainerProps = {
    onDragOver: (e: DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      const rows = e.currentTarget.querySelectorAll<HTMLElement>('[data-line-row]');
      const rects: Array<{ top: number; height: number }> = [];
      rows.forEach((el) => {
        const r = el.getBoundingClientRect();
        rects.push({ top: r.top, height: r.height });
      });
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const next = computeDropIndex(rects, e.clientY);
      // Guard the setter so we don't re-render on every mouse tick.
      setDropIndex((prev) => (prev === next ? prev : next));
    },
    onDrop: (e: DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      const fromIndex = dragId ? ids.indexOf(dragId) : -1;
      // No dragover recorded a slot → keep the item where it is (safe no-op), not append.
      const toIndex = resolveReorderIndex(fromIndex, dropIndex ?? fromIndex);
      if (dragId && toIndex !== fromIndex) onReorder(dragId, toIndex);
      clear();
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropIndex(null);
    },
  };

  const rowProps = (id: string, index: number): ReorderRowProps => ({
    draggable: !disabled,
    'data-line-row': index,
    // Firefox refuses to start a native drag unless data is set in dragstart.
    onDragStart: (e: DragEvent) => {
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
      }
      setDragId(id);
    },
    onDragEnd: () => clear(),
  });

  const handleProps = (id: string, index: number): ReorderHandleProps => ({
    'aria-keyshortcuts': 'ArrowUp ArrowDown',
    // onReorder (the page's commitReorder) owns the aria-live announce — no double-set here.
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!disabled && index > 0) onReorder(id, index - 1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!disabled && index < ids.length - 1) onReorder(id, index + 1);
      }
    },
  });

  return {
    containerProps,
    rowProps,
    handleProps,
    isDragging: (id: string) => dragId === id,
    showBefore: (index: number) => dropIndex === index,
    showAtEnd: () => dropIndex === ids.length,
  };
}
