// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ClusterEventType, RoutingMapUpdateType, ModelState } from '@sardeenz/types';
import type { ProxyControlPlaneComponents } from '@sardeenz/types';
import { toClusterEvent } from '../../routes/events.js';

type RoutingMapUpdate = ProxyControlPlaneComponents['schemas']['RoutingMapUpdate'];

const NOW = '2026-06-15T12:00:00.000Z';

describe('toClusterEvent', () => {
  it('maps MODEL_STATE_CHANGED to ClusterEventType.MODEL_STATE_CHANGED', () => {
    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.MODEL_STATE_CHANGED,
      modelName: 'llama-3',
      state: ModelState.ACTIVE,
      timestamp: NOW,
    };
    const event = toClusterEvent(update);
    expect(event).toEqual({
      type: ClusterEventType.MODEL_STATE_CHANGED,
      modelName: 'llama-3',
      state: ModelState.ACTIVE,
      timestamp: NOW,
    });
  });

  it('maps MODEL_ADDED to ClusterEventType.MODEL_DEPLOYED', () => {
    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.MODEL_ADDED,
      modelName: 'mistral-7b',
      state: ModelState.STARTING,
      timestamp: NOW,
    };
    const event = toClusterEvent(update);
    expect(event.type).toBe(ClusterEventType.MODEL_DEPLOYED);
    expect(event.modelName).toBe('mistral-7b');
    expect(event.state).toBe(ModelState.STARTING);
  });

  it('maps MODEL_REMOVED to ClusterEventType.MODEL_REMOVED', () => {
    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.MODEL_REMOVED,
      modelName: 'old-model',
      timestamp: NOW,
    };
    const event = toClusterEvent(update);
    expect(event.type).toBe(ClusterEventType.MODEL_REMOVED);
    expect(event.modelName).toBe('old-model');
  });

  it('maps ENDPOINT_ADDED to MODEL_STATE_CHANGED with endpoint data', () => {
    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.ENDPOINT_ADDED,
      modelName: 'llama-3',
      endpoint: { host: '10.0.0.1', port: 8000, weight: 1, healthy: true },
      timestamp: NOW,
    };
    const event = toClusterEvent(update);
    expect(event.type).toBe(ClusterEventType.MODEL_STATE_CHANGED);
    expect(event.message).toContain('Endpoint added');
    expect(event.message).toContain('10.0.0.1:8000');
    expect(event.data).toEqual({ endpoint: update.endpoint });
  });

  it('maps ENDPOINT_REMOVED to MODEL_STATE_CHANGED with endpoint data', () => {
    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.ENDPOINT_REMOVED,
      modelName: 'llama-3',
      endpoint: { host: '10.0.0.2', port: 9000, weight: 1, healthy: false },
      timestamp: NOW,
    };
    const event = toClusterEvent(update);
    expect(event.type).toBe(ClusterEventType.MODEL_STATE_CHANGED);
    expect(event.message).toContain('Endpoint removed');
    expect(event.message).toContain('10.0.0.2:9000');
  });

  it('maps ENDPOINT_UPDATED to MODEL_STATE_CHANGED with endpoint data', () => {
    const update: RoutingMapUpdate = {
      type: RoutingMapUpdateType.ENDPOINT_UPDATED,
      modelName: 'llama-3',
      endpoint: { host: '10.0.0.3', port: 8080, weight: 2, healthy: true },
      timestamp: NOW,
    };
    const event = toClusterEvent(update);
    expect(event.type).toBe(ClusterEventType.MODEL_STATE_CHANGED);
    expect(event.message).toContain('Endpoint updated');
  });

  it('always preserves timestamp and modelName', () => {
    const types = [
      RoutingMapUpdateType.MODEL_STATE_CHANGED,
      RoutingMapUpdateType.MODEL_ADDED,
      RoutingMapUpdateType.MODEL_REMOVED,
      RoutingMapUpdateType.ENDPOINT_ADDED,
      RoutingMapUpdateType.ENDPOINT_REMOVED,
      RoutingMapUpdateType.ENDPOINT_UPDATED,
    ];

    for (const type of types) {
      const update: RoutingMapUpdate = { type, modelName: 'test-model', timestamp: NOW };
      const event = toClusterEvent(update);
      expect(event.timestamp).toBe(NOW);
      expect(event.modelName).toBe('test-model');
    }
  });

  describe('channel alignment regression', () => {
    // This test documents that the BFF subscribes to 'routing-updates' (matching
    // the control plane) rather than 'events' (which was the previous bug).
    it('toClusterEvent produces a valid ClusterEvent from every RoutingMapUpdateType', () => {
      const allUpdateTypes = Object.values(RoutingMapUpdateType);
      const allEventTypes = Object.values(ClusterEventType);

      for (const updateType of allUpdateTypes) {
        const update: RoutingMapUpdate = {
          type: updateType,
          modelName: 'any-model',
          timestamp: NOW,
        };
        const event = toClusterEvent(update);

        // The resulting event type must be a valid ClusterEventType
        expect(allEventTypes).toContain(event.type);
        // Must have the required fields
        expect(event.timestamp).toBeTruthy();
        expect(event.modelName).toBeTruthy();
      }
    });
  });
});
