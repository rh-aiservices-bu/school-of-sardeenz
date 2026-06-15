import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bullseye,
  Spinner,
} from '@patternfly/react-core';

/**
 * Handles the OAuth callback by extracting the token from the URL fragment.
 * The AuthContext init logic already reads `#token=…` from the URL and
 * stores it in sessionStorage, so this page just needs to redirect.
 */
export function OAuthCallback() {
  const navigate = useNavigate();

  useEffect(() => {
    // Token extraction happens in AuthContext on mount.
    // Wait a tick for the auth state to settle, then redirect to root.
    const timer = setTimeout(() => {
      navigate('/', { replace: true });
    }, 100);
    return () => clearTimeout(timer);
  }, [navigate]);

  return (
    <Bullseye>
      <Spinner size="xl" aria-label="Completing login..." />
    </Bullseye>
  );
}
