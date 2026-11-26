import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Bullseye, EmptyState, EmptyStateBody, PageSection, Spinner } from '@patternfly/react-core';
import { useTranslation, withTranslation, type WithTranslation } from 'react-i18next';
import { useAuth } from './contexts/AuthContext';
import { DegradedProvider } from './contexts/DegradedContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { InferenceWorkspaceProvider } from './contexts/InferenceWorkspaceContext';
import { DegradedBanner } from './components/DegradedBanner';
import { AppLayout } from './components/AppLayout';
import { ProtectedRoute } from './components/ProtectedRoute';
import {
  EventStreamEventsContext,
  EventStreamStatusContext,
  useEventStreamConnection,
} from './hooks/useEventStream';
import { ClusterOverview } from './pages/ClusterOverview/ClusterOverview';
import { ModelList } from './pages/Models/ModelList';
import { ModelDeploy } from './pages/Models/ModelDeploy';
import { ModelDetail } from './pages/Models/ModelDetail';
import { WorkerList } from './pages/Workers/WorkerList';
import { WorkerDetail } from './pages/Workers/WorkerDetail';
import { GpuMemory } from './pages/GpuMemory/GpuMemory';
import { RunnerCatalog } from './pages/Catalog/RunnerCatalog';
import { Login } from './pages/Login/Login';
import { OAuthCallback } from './pages/Login/OAuthCallback';

// Route-level code splitting (#255): the Metrics page drags in @patternfly/react-charts/victory
// and the Playground the chatbot library + its CSS, neither of which the rest of the app uses.
// The pages keep named exports (project convention); lazy() needs a default.
const MetricsDashboard = lazy(() =>
  import('./pages/Metrics/MetricsDashboard').then((module) => ({
    default: module.MetricsDashboard,
  })),
);
const Playground = lazy(() =>
  import('./pages/Playground/Playground').then((module) => ({ default: module.Playground })),
);

function NotFoundPage() {
  const { t } = useTranslation('common');
  return (
    <PageSection>
      <EmptyState titleText={t('pageNotFound')} headingLevel="h1" variant="full">
        <EmptyStateBody>{t('pageNotFoundBody')}</EmptyStateBody>
      </EmptyState>
    </PageSection>
  );
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundaryBase extends Component<
  { children: ReactNode } & WithTranslation,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      const { t } = this.props;
      return (
        <PageSection>
          <EmptyState titleText={t('errors.somethingWrong')} headingLevel="h1" variant="full">
            <EmptyStateBody>{this.state.error?.message ?? t('errors.unexpected')}</EmptyStateBody>
          </EmptyState>
        </PageSection>
      );
    }
    return this.props.children;
  }
}

const ErrorBoundary = withTranslation('common')(ErrorBoundaryBase);

/** Restricts a route to users with the `admin` role. Read-only users are redirected to `/models`. */
function AdminRoute({ children }: { children: ReactNode }) {
  const { isAdmin, isLoading } = useAuth();
  const { t } = useTranslation('common');

  if (isLoading) {
    return (
      <Bullseye>
        <Spinner size="xl" aria-label={t('loading')} />
      </Bullseye>
    );
  }

  if (!isAdmin) {
    return <Navigate to="/models" replace />;
  }

  return <>{children}</>;
}

function EventStreamProvider({ children }: { children: ReactNode }) {
  const { status, events } = useEventStreamConnection();
  return (
    <EventStreamStatusContext.Provider value={status}>
      <EventStreamEventsContext.Provider value={events}>
        {children}
      </EventStreamEventsContext.Provider>
    </EventStreamStatusContext.Provider>
  );
}

/** Route fallback while a lazy page chunk loads (same presentation as the auth gate's spinner). */
function PageLoading() {
  const { t } = useTranslation('common');
  return (
    <Bullseye>
      <Spinner size="xl" aria-label={t('loading')} />
    </Bullseye>
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
                <NotificationProvider>
                  <InferenceWorkspaceProvider>
                    <AppLayout>
                      <ErrorBoundary>
                        <Suspense fallback={<PageLoading />}>
                          <Routes>
                            <Route path="/" element={<ClusterOverview />} />
                            <Route path="/models" element={<ModelList />} />
                            <Route
                              path="/models/deploy"
                              element={
                                <AdminRoute>
                                  <ModelDeploy />
                                </AdminRoute>
                              }
                            />
                            <Route
                              path="/models/:modelName/edit"
                              element={
                                <AdminRoute>
                                  <ModelDeploy edit />
                                </AdminRoute>
                              }
                            />
                            <Route path="/models/:modelName" element={<ModelDetail />} />
                            <Route path="/workers" element={<WorkerList />} />
                            <Route path="/workers/:workerId" element={<WorkerDetail />} />
                            <Route path="/gpu-memory" element={<GpuMemory />} />
                            <Route path="/catalog" element={<RunnerCatalog />} />
                            <Route path="/metrics" element={<MetricsDashboard />} />
                            <Route
                              path="/playground"
                              element={
                                <AdminRoute>
                                  <Playground />
                                </AdminRoute>
                              }
                            />
                            <Route path="*" element={<NotFoundPage />} />
                          </Routes>
                        </Suspense>
                      </ErrorBoundary>
                    </AppLayout>
                  </InferenceWorkspaceProvider>
                </NotificationProvider>
              </EventStreamProvider>
            </DegradedProvider>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
