import type { ModelInfo } from '../../api/client';

/** Human-facing label: optional `displayName` (ADR-020, presentation only), else `modelName`. */
export function modelLabel(model: Pick<ModelInfo, 'modelName' | 'displayName'>): string {
  return model.displayName?.trim() || model.modelName;
}
