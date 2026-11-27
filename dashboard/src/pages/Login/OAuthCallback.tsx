import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Bullseye, Spinner } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';

export function OAuthCallback() {
  const navigate = useNavigate();
  const { t } = useTranslation('auth');
  const { isAuthenticated, isLoading, exchangeCode } = useAuth();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      void navigate('/', { replace: true });
    }
  }, [isLoading, isAuthenticated, navigate]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) {
      setError(t('callback.failed'));
      return;
    }
    exchangeCode(code)
      .catch(() => setError(t('callback.failed')))
      .finally(() => window.history.replaceState(null, '', window.location.pathname));
  }, [exchangeCode, t]);

  if (error !== null) {
    return (
      <Bullseye>
        <Alert variant="danger" title={error} isInline>
          <Link to="/login">{t('callback.backToLogin')}</Link>
        </Alert>
      </Bullseye>
    );
  }

  return (
    <Bullseye>
      <Spinner size="xl" aria-label={t('callback.completingLogin')} />
    </Bullseye>
  );
}
