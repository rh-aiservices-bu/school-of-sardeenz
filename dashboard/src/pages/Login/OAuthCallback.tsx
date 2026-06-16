import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bullseye,
  Spinner,
} from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';

export function OAuthCallback() {
  const navigate = useNavigate();
  const { t } = useTranslation('auth');
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      navigate('/', { replace: true });
    }
  }, [isLoading, isAuthenticated, navigate]);

  return (
    <Bullseye>
      <Spinner size="xl" aria-label={t('callback.completingLogin')} />
    </Bullseye>
  );
}
