import { Component, type ReactNode } from 'react';
import { EmptyState, EmptyStateBody, PageSection } from '@patternfly/react-core';
import { withTranslation, type WithTranslation } from 'react-i18next';

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

/**
 * Page-level error containment: renders a fallback instead of a blank screen when a descendant
 * throws during render.
 *
 * Lives in its own module rather than inside App.tsx so unit tests can render the real boundary
 * without importing the whole page tree (App.tsx imports every page, including the
 * chatbot/monaco Playground graph) — same reason as ProtectedRoute.
 */
export const ErrorBoundary = withTranslation('common')(ErrorBoundaryBase);
