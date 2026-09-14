import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { PlaygroundMessage } from './types';

const BOTTOM_TOLERANCE_PX = 4;
/** Time constant of the exponential ease: the remaining distance shrinks by ~63% every 140 ms. */
const EASE_TAU_MS = 140;
/** Below this remaining distance the animation snaps to the target and stops. */
const SNAP_PX = 0.5;

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
 * - when a new turn starts, glide so the new user prompt sits at the top of the message box and
 *   the reply unfolds below it. A trailing spacer (`spacerRef`) gives the newest turn a full box
 *   of room so the move is never clamped by a short conversation;
 * - while the reply streams, follow the bottom so the newest text stays visible (the spacer
 *   shrinks as the reply grows, so the prompt holds its place until the reply overflows);
 * - if the user scrolls up during a reply, stop following; scrolling back to the bottom resumes.
 *
 * All programmatic movement goes through one eased animation that chases a moving target each
 * frame, so following a stream is a continuous glide rather than a hop per wrapped line.
 * Message elements are located with `data-message-id`; the box element is the scroll container.
 * The spacer's height is written straight to the DOM (never through React) so it can be sized
 * before the move within the same layout pass.
 */
export function useChatScroll(
  boxRef: RefObject<HTMLElement | null>,
  spacerRef: RefObject<HTMLElement | null>,
  messages: PlaygroundMessage[],
  isGenerating: boolean,
): ChatScrollController {
  const followRef = useRef(true);
  const lastTurnIdRef = useRef<string | null>(null);
  const wasGeneratingRef = useRef(false);

  // Animation state: where we are heading, the frame handle, and the position we last wrote
  // (so a scroll event that lands elsewhere is recognised as the user's own scrolling).
  const targetRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef(0);
  const lastWrittenRef = useRef<number | null>(null);

  const stopAnimation = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    targetRef.current = null;
    lastWrittenRef.current = null;
  }, []);

  const step = useCallback(
    (now: number) => {
      frameRef.current = null;
      const box = boxRef.current;
      const target = targetRef.current;
      if (!box || target === null) return;

      const clamped = Math.min(target, box.scrollHeight - box.clientHeight);
      const remaining = clamped - box.scrollTop;
      const dt = lastFrameAtRef.current ? now - lastFrameAtRef.current : 16;
      lastFrameAtRef.current = now;

      let next: number;
      if (Math.abs(remaining) <= SNAP_PX) {
        next = clamped;
      } else {
        // Browsers round scrollTop to whole pixels, so keep every step at least 1px (without
        // overshooting) or the ease would stall just short of the target.
        const fraction = 1 - Math.exp(-dt / EASE_TAU_MS);
        const eased = Math.abs(remaining) * fraction;
        const magnitude = Math.min(Math.abs(remaining), Math.max(1, eased));
        next = box.scrollTop + Math.sign(remaining) * magnitude;
      }
      box.scrollTop = next;
      lastWrittenRef.current = box.scrollTop;

      if (Math.abs(clamped - box.scrollTop) <= SNAP_PX) {
        targetRef.current = null;
        return;
      }
      frameRef.current = requestAnimationFrame(step);
    },
    [boxRef],
  );

  const glideTo = useCallback(
    (top: number) => {
      const box = boxRef.current;
      if (!box) return;
      if (prefersReducedMotion()) {
        stopAnimation();
        box.scrollTop = top;
        lastWrittenRef.current = box.scrollTop;
        return;
      }
      targetRef.current = top;
      if (frameRef.current === null) {
        lastFrameAtRef.current = 0;
        frameRef.current = requestAnimationFrame(step);
      }
    },
    [boxRef, step, stopAnimation],
  );

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
      stopAnimation();
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
      glideTo(targetTop);
      return;
    }

    // Follow while streaming and on the update that completes the turn (it appends the metrics
    // line after generation has already ended).
    const settling = wasGeneratingRef.current && !isGenerating;
    wasGeneratingRef.current = isGenerating;
    if ((isGenerating || settling) && followRef.current) {
      const maxTop = box.scrollHeight - box.clientHeight;
      if (maxTop > box.scrollTop + SNAP_PX) glideTo(maxTop);
    }
  }, [boxRef, spacerRef, messages, latestUserId, isGenerating, glideTo, stopAnimation]);

  useEffect(() => stopAnimation, [stopAnimation]);

  const onScroll = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const written = lastWrittenRef.current;
    const isOurs = written !== null && Math.abs(box.scrollTop - written) <= 1;
    if (isOurs) return;
    // The user moved the box themselves: abandon any glide and decide whether to keep following.
    stopAnimation();
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - BOTTOM_TOLERANCE_PX;
    followRef.current = atBottom;
  }, [boxRef, stopAnimation]);

  return { onScroll };
}
