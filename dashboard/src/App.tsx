import { Component, type ReactNode } from 'react';
import { Routes, Route } from 'react-router-dom';
import {
  EmptyState,
  EmptyStateBody,
  PageSection,
} from '@patternfly/react-core';
import { AppLayout } from './components/AppLayout';
import { ClusterOverview } from './pages/ClusterOverview/ClusterOverview';
import { ModelList } from './pages/Models/ModelList';
import { ModelDeploy } from './pages/Models/ModelDeploy';
import { ModelDetail } from './pages/Models/ModelDetail';
import { WorkerList } from './pages/Workers/WorkerList';
import { WorkerDetail } from './pages/Workers/WorkerDetail';
import { MetricsDashboard } from './pages/Metrics/MetricsDashboard';

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

export function App() {
  return (
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
  );
}
