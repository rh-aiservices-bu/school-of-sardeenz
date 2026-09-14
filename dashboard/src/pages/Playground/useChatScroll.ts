import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { PlaygroundMessage } from './types';

/** Scroll events fired within this window after a smooth programmatic jump are not user intent. */
const SMOOTH_SCROLL_GRACE_MS = 700;
const BOTTOM_TOLERANCE_PX = 4;

export interface ChatScrollController {
  /** Attach to the scrollable message box (`onScroll`). */
  onScroll: () => void;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Chat-style scrolling for one pane:
 * - when a new turn starts, jump so the new user prompt sits at the top of the message box and
 *   the reply unfolds below it. A trailing spacer (`spacerRef`) gives the newest turn a full box
 *   of room so the jump is never clamped by a short conversation;
 * - while the reply streams, follow the bottom so the newest text stays visible (the spacer
 *   shrinks as the reply grows, so the prompt holds its place until the reply overflows);
 * - if the user scrolls up during a reply, stop following; scrolling back to the bottom resumes.
 *
 * Message elements are located with `data-message-id`; the box element is the scroll container.
 * The spacer's height is written straight to the DOM (never through React) so it can be sized
 * before the jump within the same layout pass.
 */
export function useChatScroll(
  boxRef: RefObject<HTMLElement | null>,
  spacerRef: RefObject<HTMLElement | null>,
  messages: PlaygroundMessage[],
  isGenerating: boolean,
): ChatScrollController {
  const followRef = useRef(true);
  const lastTurnIdRef = useRef<string | null>(null);
  const suppressUntilRef = useRef(0);

  const latestUserId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id;
    }
    return null;
  })();

  useLayoutEffect(() => {
    const box = boxRef.current;
    const spacer = spacerRef.current;
    if (!box) return;

    if (messages.length === 0 || !latestUserId) {
      lastTurnIdRef.current = null;
      followRef.current = true;
      if (spacer) spacer.style.height = '0px';
      return;
    }

    const userEl = box.querySelector<HTMLElement>(`[data-message-id="${latestUserId}"]`);
    if (!userEl) return;

    // Scroll offset that puts the prompt just below the box's top padding.
    const paddingTop = parseFloat(getComputedStyle(box).paddingTop) || 0;
    const promptOffset =
      userEl.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    const targetTop = Math.max(0, promptOffset - paddingTop);

    // Size the spacer so the scroll range reaches exactly `targetTop` while the turn fits, and
    // collapses to nothing once the reply has grown past one box height.
    if (spacer) {
      spacer.style.height = '0px';
      const room = targetTop + box.clientHeight - box.scrollHeight;
      spacer.style.height = `${Math.max(0, room)}px`;
    }

    const isNewTurn = latestUserId !== lastTurnIdRef.current;
    if (isNewTurn) {
      lastTurnIdRef.current = latestUserId;
      followRef.current = true;
      const smooth = !prefersReducedMotion();
      if (smooth) suppressUntilRef.current = performance.now() + SMOOTH_SCROLL_GRACE_MS;
      box.scrollTo({ top: targetTop, behavior: smooth ? 'smooth' : 'auto' });
      return;
    }

    if (isGenerating && followRef.current) {
      const maxTop = box.scrollHeight - box.clientHeight;
      if (box.scrollTop < maxTop) {
        suppressUntilRef.current = Math.max(suppressUntilRef.current, performance.now() + 50);
        box.scrollTop = maxTop;
      }
    }
  }, [boxRef, spacerRef, messages, latestUserId, isGenerating]);

  const onScroll = useCallback(() => {
    const box = boxRef.current;
    if (!box || performance.now() < suppressUntilRef.current) return;
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - BOTTOM_TOLERANCE_PX;
    followRef.current = atBottom;
  }, [boxRef]);

  return { onScroll };
}
