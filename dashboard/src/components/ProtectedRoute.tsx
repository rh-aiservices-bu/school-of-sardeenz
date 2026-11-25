import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Bullseye, Spinner } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';

/**
 * Auth gate for the app's route tree: passes children through when auth is
 * disabled, shows a spinner while the auth state loads, and redirects to
 * /login (remembering the origin) when the user is not authenticated.
 *
 * Lives in its own module rather than inside App.tsx so unit tests can render
 * the real gate without importing the whole page tree (App.tsx imports every
 * page, including the chatbot/monaco Playground graph).
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, authMode } = useAuth();
  const location = useLocation();
  const { t } = useTranslation('common');

  // Auth disabled — always pass
  if (authMode === 'none') return <>{children}</>;

  // Still loading auth state
  if (isLoading) {
    return (
      <Bullseye>
        <Spinner size="xl" aria-label={t('loading')} />
      </Bullseye>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return <>{children}</>;
}
