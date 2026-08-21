import { ModelLifecycleState } from '@sardeenz/types';

import type { ModelState } from './model-lifecycle.js';
import { evictionsTotal, evictionDuration } from '../health/metrics.js';

export interface EvictionCandidate {
  modelName: string;
  state: ModelLifecycleState;
  workerId: string;
  memoryBytes: number;
  lastInferenceAt: string | null;
  pinned: boolean;
}

export interface EvictionStrategy {
  selectVictims(candidates: EvictionCandidate[], requiredBytes: number): EvictionCandidate[];
}

export class LruEvictionStrategy implements EvictionStrategy {
  selectVictims(candidates: EvictionCandidate[], requiredBytes: number): EvictionCandidate[] {
    const sorted = [...candidates].sort((a, b) => {
      if (!a.lastInferenceAt && !b.lastInferenceAt) return 0;
      if (!a.lastInferenceAt) return -1;
      if (!b.lastInferenceAt) return 1;
      return a.lastInferenceAt.localeCompare(b.lastInferenceAt);
    });

    const victims: EvictionCandidate[] = [];
    let freed = 0;

    for (const candidate of sorted) {
      if (freed >= requiredBytes) break;
      victims.push(candidate);
      freed += candidate.memoryBytes;
    }

    return victims;
  }
}

export interface EvictionConfig {
  maxPerCycle: number;
  minActiveTimeSecs: number;
  circuitBreakerThreshold: number;
  circuitBreakerWindowSecs: number;
}

export class EvictionEngine {
  private recentEvictions: number[] = [];

  constructor(
    private readonly strategy: EvictionStrategy = new LruEvictionStrategy(),
    private readonly config: EvictionConfig = {
      maxPerCycle: 3,
      minActiveTimeSecs: 60,
      circuitBreakerThreshold: 5,
      circuitBreakerWindowSecs: 60,
    },
  ) {}

  selectVictims(
    allModels: ModelState[],
    pinnedModels: Set<string>,
    requiredBytes: number,
    targetWorkerIds?: ReadonlySet<string>,
    memoryByModel?: Map<string, number>,
  ): EvictionCandidate[] {
    if (this.isCircuitBreakerOpen()) {
      return [];
    }

    const candidates = allModels
      .filter(
        (m) => m.state === ModelLifecycleState.ACTIVE || m.state === ModelLifecycleState.SLEEPING,
      )
      .filter((m) => !pinnedModels.has(m.modelName))
      .filter((m) => !targetWorkerIds || targetWorkerIds.has(m.workerId ?? ''))
      .filter((m) => {
        if (!m.stateChangedAt) return true;
        const activeAge = (Date.now() - new Date(m.stateChangedAt).getTime()) / 1000;
        return activeAge >= this.config.minActiveTimeSecs;
      })
      .map(
        (m): EvictionCandidate => ({
          modelName: m.modelName,
          state: m.state,
          workerId: m.workerId ?? '',
          memoryBytes: memoryByModel?.get(m.modelName) ?? 0,
          lastInferenceAt: m.lastInferenceAt,
          pinned: false,
        }),
      );

    // A model with unknown/zero memoryBytes (not yet in memoryByModel, or a stale record)
    // "frees" nothing when evicted — including it would let the LRU strategy pick it as a victim
    // without ever satisfying requiredBytes, evicting models for no gain.
    const zeroSize = candidates.filter((c) => c.memoryBytes <= 0);
    if (zeroSize.length > 0) {
      console.warn(
        `Eviction: skipping candidates with zero/unknown memoryBytes: ${zeroSize.map((c) => c.modelName).join(', ')}`,
      );
    }
    const sizedCandidates = candidates.filter((c) => c.memoryBytes > 0);

    if (sizedCandidates.length === 0) return [];

    const victims = this.strategy.selectVictims(sizedCandidates, requiredBytes);
    return victims.slice(0, this.config.maxPerCycle);
  }

  recordEviction(reason: string): void {
    this.recentEvictions.push(Date.now());
    evictionsTotal.inc({ reason });
  }

  startTimer(): () => void {
    return evictionDuration.startTimer();
  }

  private isCircuitBreakerOpen(): boolean {
    const windowMs = this.config.circuitBreakerWindowSecs * 1000;
    const cutoff = Date.now() - windowMs;
    this.recentEvictions = this.recentEvictions.filter((t) => t > cutoff);
    return this.recentEvictions.length >= this.config.circuitBreakerThreshold;
  }
}
