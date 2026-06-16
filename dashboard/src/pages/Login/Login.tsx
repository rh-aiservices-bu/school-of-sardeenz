import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import {
  LoginPage,
  LoginForm,
} from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';

export function Login() {
  const { authMode, isAuthenticated, isLoading, login, loginError } = useAuth();
  const location = useLocation();
  const { t } = useTranslation('auth');
  const from = (location.state as { from?: string })?.from ?? '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // If auth is disabled, redirect immediately
  if (authMode === 'none' || (!isLoading && isAuthenticated)) {
    return <Navigate to={from} replace />;
  }

  // OAuth mode — show SSO button
  if (authMode === 'oauth') {
    const handleSsoLogin = () => {
      const baseUrl = import.meta.env.VITE_API_URL ?? '/api';
      window.location.href = `${baseUrl}/auth/login`;
    };

    return (
      <LoginPage
        loginTitle={t('login.title')}
        loginSubtitle={t('login.subtitleSso')}
        textContent={t('login.textContent')}
        socialMediaLoginContent={
          <LoginForm
            loginButtonLabel={t('login.loginButtonSso')}
            onLoginButtonClick={handleSsoLogin}
          />
        }
      />
    );
  }

  // Simple mode — username/password form
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    login(username, password)
      .catch(() => {
        // Error is set in context
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  };

  return (
    <LoginPage
      loginTitle={t('login.title')}
      loginSubtitle={t('login.subtitleSimple')}
      textContent={t('login.textContent')}
    >
      <LoginForm
        showHelperText={!!loginError}
        helperText={loginError ?? undefined}
        helperTextIcon={undefined}
        usernameLabel={t('login.usernameLabel')}
        usernameValue={username}
        onChangeUsername={(_e, value) => setUsername(value)}
        passwordLabel={t('login.passwordLabel')}
        passwordValue={password}
        onChangePassword={(_e, value) => setPassword(value)}
        isLoginButtonDisabled={isSubmitting}
        loginButtonLabel={isSubmitting ? t('login.loggingIn') : t('login.loginButton')}
        onLoginButtonClick={handleSubmit}
      />
    </LoginPage>
  );
}
