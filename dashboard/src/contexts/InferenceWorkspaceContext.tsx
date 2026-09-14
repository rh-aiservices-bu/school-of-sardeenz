import { createContext, useContext, type ReactNode } from 'react';
import { useWorkspaceState } from '../pages/Playground/useWorkspaceState';
import type { WorkspaceActions, WorkspaceState } from '../pages/Playground/workspace-types';

type InferenceWorkspaceContextType = WorkspaceState & WorkspaceActions;

const InferenceWorkspaceContext = createContext<InferenceWorkspaceContextType | null>(null);

/**
 * App-level provider for the Playground workspace so open sessions, layout, and sidebar state
 * survive navigating to other pages and back (v1 parity).
 */
export function InferenceWorkspaceProvider({ children }: { children: ReactNode }) {
  const workspaceState = useWorkspaceState();
  return (
    <InferenceWorkspaceContext.Provider value={workspaceState}>
      {children}
    </InferenceWorkspaceContext.Provider>
  );
}

export function useInferenceWorkspace(): InferenceWorkspaceContextType {
  const context = useContext(InferenceWorkspaceContext);
  if (!context) {
    throw new Error('useInferenceWorkspace must be used within an InferenceWorkspaceProvider');
  }
  return context;
}
