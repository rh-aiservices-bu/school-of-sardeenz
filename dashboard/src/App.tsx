import { Component, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import {
  Bullseye,
  EmptyState,
  EmptyStateBody,
  PageSection,
  Spinner,
} from '@patternfly/react-core';
import { useAuth } from './contexts/AuthContext';
import { DegradedProvider } from './contexts/DegradedContext';
import { DegradedBanner } from './components/DegradedBanner';
import { AppLayout } from './components/AppLayout';
import { EventStreamContext, useEventStreamConnection } from './hooks/useEventStream';
import { ClusterOverview } from './pages/ClusterOverview/ClusterOverview';
import { ModelList } from './pages/Models/ModelList';
import { ModelDeploy } from './pages/Models/ModelDeploy';
import { ModelDetail } from './pages/Models/ModelDetail';
import { WorkerList } from './pages/Workers/WorkerList';
import { WorkerDetail } from './pages/Workers/WorkerDetail';
import { MetricsDashboard } from './pages/Metrics/MetricsDashboard';
import { Login } from './pages/Login/Login';
import { OAuthCallback } from './pages/Login/OAuthCallback';

function NotFoundPage() {
  return (
    <PageSection>
      <EmptyState titleText="Page not found" headingLevel="h1" variant="full">
        <EmptyStateBody>
          The requested page does not exist. Use the sidebar to navigate to a valid page.
        </EmptyStateBody>
      </EmptyState>
    </PageSection>
  );
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <PageSection>
          <EmptyState titleText="Something went wrong" headingLevel="h1" variant="full">
            <EmptyStateBody>
              {this.state.error?.message ?? 'An unexpected error occurred.'}
            </EmptyStateBody>
          </EmptyState>
        </PageSection>
      );
    }
    return this.props.children;
  }
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, authMode } = useAuth();
  const location = useLocation();

  // Auth disabled — always pass
  if (authMode === 'none') return <>{children}</>;

  // Still loading auth state
  if (isLoading) {
    return (
      <Bullseye>
        <Spinner size="xl" aria-label="Loading..." />
      </Bullseye>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return <>{children}</>;
}

function EventStreamProvider({ children }: { children: ReactNode }) {
  const state = useEventStreamConnection();
  return (
    <EventStreamContext.Provider value={state}>
      {children}
    </EventStreamContext.Provider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/oauth/callback" element={<OAuthCallback />} />
      <Route
        path="*"
        element={
          <ProtectedRoute>
            <DegradedProvider>
              <DegradedBanner />
              <EventStreamProvider>
                <AppLayout>
                  <ErrorBoundary>
                    <Routes>
                      <Route path="/" element={<ClusterOverview />} />
                      <Route path="/models" element={<ModelList />} />
                      <Route path="/models/deploy" element={<ModelDeploy />} />
                      <Route path="/models/:modelName" element={<ModelDetail />} />
                      <Route path="/workers" element={<WorkerList />} />
                      <Route path="/workers/:workerId" element={<WorkerDetail />} />
                      <Route path="/metrics" element={<MetricsDashboard />} />
                      <Route path="*" element={<NotFoundPage />} />
                    </Routes>
                  </ErrorBoundary>
                </AppLayout>
              </EventStreamProvider>
            </DegradedProvider>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
