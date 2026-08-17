import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RunnerStateMachine } from '../../runner-stub/state.js';
import type { RunnerState, LoadingPhase } from '../../runner-stub/state.js';

describe('RunnerStateMachine', () => {
  let machine: RunnerStateMachine;

  beforeEach(() => {
    machine = new RunnerStateMachine();
  });

  afterEach(() => {
    machine.destroy();
  });

  describe('initial state', () => {
    it('starts in STARTING state', () => {
      expect(machine.state).toBe('STARTING');
    });

    it('initializes with INITIALIZING phase at 0%', () => {
      const progress = machine.progress;
      expect(progress.phase).toBe('INITIALIZING');
      expect(progress.percentComplete).toBe(0);
      expect(progress.message).toBe('Initializing');
    });

    it('has no active requests', () => {
      expect(machine.activeRequests).toBe(0);
    });

    it('has no sleep level', () => {
      expect(machine.sleepLevel).toBeNull();
    });
  });

  describe('simulateStartup', () => {
    it('transitions to READY state after startup completes', async () => {
      const startupPromise = machine.simulateStartup(100);
      expect(machine.state).toBe('STARTING');
      await startupPromise;
      expect(machine.state).toBe('READY');
    });

    it('advances through all loading phases', async () => {
      const phases: LoadingPhase[] = [];
      const checkPhase = async (): Promise<void> => {
        const startupPromise = machine.simulateStartup(500);

        // Sample phases during startup
        for (let i = 0; i < 6; i++) {
          await new Promise((resolve) => setTimeout(resolve, 80));
          phases.push(machine.progress.phase);
        }

        await startupPromise;
        phases.push(machine.progress.phase);
      };

      await checkPhase();

      // Should see INITIALIZING early on
      expect(phases).toContain('INITIALIZING');
      // Should see LOADING_WEIGHTS in middle phases
      expect(phases).toContain('LOADING_WEIGHTS');
      // Should see ALLOCATING_MEMORY later
      expect(phases).toContain('ALLOCATING_MEMORY');
      // Should end at READY
      expect(phases[phases.length - 1]).toBe('READY');
    });

    it('progresses through phases in correct order', async () => {
      const phases: LoadingPhase[] = [];
      const startupPromise = machine.simulateStartup(400);

      // Sample at specific intervals to catch phase transitions
      const intervals = [50, 100, 150, 250, 350, 400];
      for (const ms of intervals) {
        await new Promise((resolve) =>
          setTimeout(resolve, ms - (intervals[intervals.indexOf(ms) - 1] || 0)),
        );
        phases.push(machine.progress.phase);
      }

      await startupPromise;

      // Verify phase progression (should be monotonically advancing)
      const phaseOrder: LoadingPhase[] = [
        'INITIALIZING',
        'LOADING_WEIGHTS',
        'ALLOCATING_MEMORY',
        'READY',
      ];
      let lastPhaseIdx = -1;
      for (const phase of phases) {
        const currentIdx = phaseOrder.indexOf(phase);
        expect(currentIdx).toBeGreaterThanOrEqual(lastPhaseIdx);
        lastPhaseIdx = currentIdx;
      }
    });

    it('reaches 100% progress when READY', async () => {
      await machine.simulateStartup(100);
      const progress = machine.progress;
      expect(progress.percentComplete).toBe(100);
      expect(progress.phase).toBe('READY');
      expect(progress.message).toBe('Ready');
    });

    it('increments percentComplete over time', async () => {
      const startupPromise = machine.simulateStartup(300);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const pct1 = machine.progress.percentComplete;

      await new Promise((resolve) => setTimeout(resolve, 100));
      const pct2 = machine.progress.percentComplete;

      await new Promise((resolve) => setTimeout(resolve, 100));
      const pct3 = machine.progress.percentComplete;

      await startupPromise;
      const pct4 = machine.progress.percentComplete;

      expect(pct1).toBeGreaterThanOrEqual(0);
      expect(pct2).toBeGreaterThan(pct1);
      expect(pct3).toBeGreaterThan(pct2);
      expect(pct4).toBe(100);
    });
  });

  describe('sleep', () => {
    it('transitions from READY to SLEEPING', async () => {
      await machine.simulateStartup(50);
      expect(machine.state).toBe('READY');

      const sleepPromise = machine.sleep('L1', 50);
      expect(machine.state).toBe('SLEEPING');

      await sleepPromise;
      expect(machine.state).toBe('SLEEPING');
    });

    it('sets sleep level', async () => {
      await machine.simulateStartup(50);
      void machine.sleep('L2', 50);
      expect(machine.sleepLevel).toBe('L2');
    });

    it('throws when called from STARTING state', async () => {
      expect(machine.state).toBe('STARTING');
      await expect(machine.sleep('L1', 50)).rejects.toThrow('Cannot sleep from state STARTING');
    });

    it('throws when called from SLEEPING state', async () => {
      await machine.simulateStartup(50);
      await machine.sleep('L1', 10);
      expect(machine.state).toBe('SLEEPING');
      await expect(machine.sleep('L2', 50)).rejects.toThrow('Cannot sleep from state SLEEPING');
    });

    it('throws when called from ERROR state', async () => {
      machine.setError('test error');
      expect(machine.state).toBe('ERROR');
      await expect(machine.sleep('L1', 50)).rejects.toThrow('Cannot sleep from state ERROR');
    });

    it('returns 0 VRAM bytes freed', async () => {
      await machine.simulateStartup(50);
      const freed = await machine.sleep('L1', 50);
      expect(freed).toBe(0);
    });
  });

  describe('wake', () => {
    it('transitions from SLEEPING back to READY', async () => {
      await machine.simulateStartup(50);
      await machine.sleep('L1', 10);
      expect(machine.state).toBe('SLEEPING');

      await machine.wake(50);
      expect(machine.state).toBe('READY');
    });

    it('clears sleep level when waking', async () => {
      await machine.simulateStartup(50);
      await machine.sleep('L2', 10);
      expect(machine.sleepLevel).toBe('L2');

      await machine.wake(50);
      expect(machine.sleepLevel).toBeNull();
    });

    it('goes through startup phases when waking', async () => {
      await machine.simulateStartup(50);
      await machine.sleep('L1', 10);

      const wakePromise = machine.wake(500);

      // Should be back in STARTING during wake
      expect(machine.state).toBe('STARTING');

      await new Promise((resolve) => setTimeout(resolve, 150));
      // During the early phase of wake, progress should not yet be READY
      expect(machine.progress.percentComplete).toBeLessThan(100);

      await wakePromise;
      expect(machine.state).toBe('READY');
      expect(machine.progress.phase).toBe('READY');
    });

    it('throws when called from STARTING state', async () => {
      expect(machine.state).toBe('STARTING');
      await expect(machine.wake(50)).rejects.toThrow('Cannot wake from state STARTING');
    });

    it('throws when called from READY state', async () => {
      await machine.simulateStartup(50);
      expect(machine.state).toBe('READY');
      await expect(machine.wake(50)).rejects.toThrow('Cannot wake from state READY');
    });

    it('throws when called from ERROR state', async () => {
      machine.setError('test error');
      expect(machine.state).toBe('ERROR');
      await expect(machine.wake(50)).rejects.toThrow('Cannot wake from state ERROR');
    });
  });

  describe('activeRequests tracking', () => {
    it('increments active requests', () => {
      expect(machine.activeRequests).toBe(0);
      machine.incrementRequests();
      expect(machine.activeRequests).toBe(1);
      machine.incrementRequests();
      expect(machine.activeRequests).toBe(2);
    });

    it('decrements active requests', () => {
      machine.incrementRequests();
      machine.incrementRequests();
      machine.incrementRequests();
      expect(machine.activeRequests).toBe(3);

      machine.decrementRequests();
      expect(machine.activeRequests).toBe(2);
      machine.decrementRequests();
      expect(machine.activeRequests).toBe(1);
    });

    it('does not go below zero when decrementing', () => {
      expect(machine.activeRequests).toBe(0);
      machine.decrementRequests();
      expect(machine.activeRequests).toBe(0);
      machine.decrementRequests();
      expect(machine.activeRequests).toBe(0);
    });

    it('tracks requests independently of state transitions', async () => {
      machine.incrementRequests();
      machine.incrementRequests();

      await machine.simulateStartup(50);
      expect(machine.activeRequests).toBe(2);

      await machine.sleep('L1', 10);
      expect(machine.activeRequests).toBe(2);

      machine.decrementRequests();
      expect(machine.activeRequests).toBe(1);
    });
  });

  describe('setError', () => {
    it('transitions to ERROR state', () => {
      machine.setError('Test error message');
      expect(machine.state).toBe('ERROR');
    });

    it('sets error message in progress', () => {
      machine.setError('Critical failure');
      const progress = machine.progress;
      expect(progress.message).toBe('Critical failure');
    });

    it('resets progress phase and percentage on error', () => {
      machine.setError('Error occurred');
      const progress = machine.progress;
      expect(progress.phase).toBe('INITIALIZING');
      expect(progress.percentComplete).toBe(0);
    });

    it('can be called from any state', async () => {
      // From STARTING
      expect(machine.state).toBe('STARTING');
      machine.setError('Error in STARTING');
      expect(machine.state).toBe('ERROR');

      // Reset
      machine = new RunnerStateMachine();
      await machine.simulateStartup(50);

      // From READY
      expect(machine.state).toBe('READY');
      machine.setError('Error in READY');
      expect(machine.state).toBe('ERROR');

      // Reset
      machine = new RunnerStateMachine();
      await machine.simulateStartup(50);
      await machine.sleep('L1', 10);

      // From SLEEPING
      expect(machine.state).toBe('SLEEPING');
      machine.setError('Error in SLEEPING');
      expect(machine.state).toBe('ERROR');
    });
  });

  describe('destroy', () => {
    it('cleans up startup timer', async () => {
      const startupPromise = machine.simulateStartup(1000);

      // Destroy mid-startup
      await new Promise((resolve) => setTimeout(resolve, 50));
      machine.destroy();

      // Should complete immediately after destroy
      await startupPromise;
    });

    it('can be called multiple times safely', () => {
      expect(() => {
        machine.destroy();
        machine.destroy();
        machine.destroy();
      }).not.toThrow();
    });

    it('can be called when no timer is active', async () => {
      await machine.simulateStartup(50);
      expect(() => machine.destroy()).not.toThrow();
    });

    it('stops startup timer from continuing', async () => {
      const phases: RunnerState[] = [];
      const startupPromise = machine.simulateStartup(500);

      await new Promise((resolve) => setTimeout(resolve, 50));
      phases.push(machine.state);

      machine.destroy();
      await startupPromise;

      // Wait a bit more to ensure timer doesn't fire
      await new Promise((resolve) => setTimeout(resolve, 100));
      phases.push(machine.state);

      // State should not have changed after destroy
      expect(phases[0]).toBe(phases[1]);
    });
  });

  describe('progress getter returns copy', () => {
    it('returns a new object each time', () => {
      const p1 = machine.progress;
      const p2 = machine.progress;
      expect(p1).not.toBe(p2);
      expect(p1).toEqual(p2);
    });

    it('mutations do not affect internal state', () => {
      const p1 = machine.progress;
      p1.percentComplete = 999;
      p1.phase = 'READY';
      p1.message = 'Modified';

      const p2 = machine.progress;
      expect(p2.percentComplete).toBe(0);
      expect(p2.phase).toBe('INITIALIZING');
      expect(p2.message).toBe('Initializing');
    });
  });
});
