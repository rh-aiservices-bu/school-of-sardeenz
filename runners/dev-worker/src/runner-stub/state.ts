export type RunnerState = 'STARTING' | 'READY' | 'BUSY' | 'SLEEPING' | 'ERROR';
export type LoadingPhase = 'INITIALIZING' | 'LOADING_WEIGHTS' | 'ALLOCATING_MEMORY' | 'READY';

export interface RunnerProgress {
  phase: LoadingPhase;
  percentComplete: number;
  message: string;
}

const LOADING_PHASES: { phase: LoadingPhase; pct: number; fraction: number }[] = [
  { phase: 'INITIALIZING', pct: 0, fraction: 0.1 },
  { phase: 'LOADING_WEIGHTS', pct: 10, fraction: 0.5 },
  { phase: 'ALLOCATING_MEMORY', pct: 60, fraction: 0.3 },
  { phase: 'READY', pct: 100, fraction: 0.1 },
];

export class RunnerStateMachine {
  private _state: RunnerState = 'STARTING';
  private _progress: RunnerProgress = {
    phase: 'INITIALIZING',
    percentComplete: 0,
    message: 'Initializing',
  };
  private _activeRequests = 0;
  private _sleepLevel: string | null = null;
  private startupResolve: (() => void) | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  get state(): RunnerState {
    return this._state;
  }

  get progress(): RunnerProgress {
    return { ...this._progress };
  }

  get activeRequests(): number {
    return this._activeRequests;
  }

  get sleepLevel(): string | null {
    return this._sleepLevel;
  }

  incrementRequests(): void {
    this._activeRequests++;
  }

  decrementRequests(): void {
    this._activeRequests = Math.max(0, this._activeRequests - 1);
  }

  simulateStartup(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.startupResolve = resolve;
      this._state = 'STARTING';
      this._progress = {
        phase: 'INITIALIZING',
        percentComplete: 0,
        message: 'Loading: INITIALIZING',
      };

      let elapsed = 0;
      let phaseIdx = 0;

      const tick = (): void => {
        elapsed += 100;
        const fraction = elapsed / delayMs;

        while (phaseIdx < LOADING_PHASES.length - 1) {
          let cumulative = 0;
          for (let i = 0; i <= phaseIdx; i++) {
            cumulative += LOADING_PHASES[i].fraction;
          }
          if (fraction >= cumulative) {
            phaseIdx++;
          } else {
            break;
          }
        }

        const phase = LOADING_PHASES[phaseIdx];
        this._progress = {
          phase: phase.phase,
          percentComplete: Math.min(Math.round(fraction * 100), 100),
          message: `Loading: ${phase.phase}`,
        };

        if (elapsed >= delayMs) {
          this._state = 'READY';
          this._progress = { phase: 'READY', percentComplete: 100, message: 'Ready' };
          this.startupTimer = null;
          resolve();
        } else {
          this.startupTimer = setTimeout(tick, 100);
        }
      };

      this.startupTimer = setTimeout(tick, 100);
    });
  }

  async sleep(level: string, delayMs: number): Promise<number> {
    if (this._state !== 'READY') {
      throw new Error(`Cannot sleep from state ${this._state}`);
    }
    this._state = 'SLEEPING';
    this._sleepLevel = level;
    await delay(delayMs);
    return 0;
  }

  async wake(delayMs: number): Promise<void> {
    if (this._state !== 'SLEEPING') {
      throw new Error(`Cannot wake from state ${this._state}`);
    }
    this._sleepLevel = null;
    await this.simulateStartup(delayMs);
  }

  setError(message: string): void {
    this._state = 'ERROR';
    this._progress = { phase: 'INITIALIZING', percentComplete: 0, message };
  }

  destroy(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.startupResolve) {
      this.startupResolve();
      this.startupResolve = null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
