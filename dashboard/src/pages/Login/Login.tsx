import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import {
  LoginPage,
  LoginForm,
} from '@patternfly/react-core';
import { useAuth } from '../../contexts/AuthContext';

export function Login() {
  const { authMode, isAuthenticated, isLoading, login, loginError } = useAuth();
  const location = useLocation();
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
      const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
      window.location.href = `${baseUrl}/auth/login`;
    };

    return (
      <LoginPage
        loginTitle="Log in to Sardeenz"
        loginSubtitle="Use your organization SSO credentials"
        textContent="Sardeenz GPU Workload Orchestration Platform"
        socialMediaLoginContent={
          <LoginForm
            loginButtonLabel="Log in with SSO"
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
      loginTitle="Log in to Sardeenz"
      loginSubtitle="Enter your admin credentials"
      textContent="Sardeenz GPU Workload Orchestration Platform"
    >
      <LoginForm
        showHelperText={!!loginError}
        helperText={loginError ?? undefined}
        helperTextIcon={undefined}
        usernameLabel="Username"
        usernameValue={username}
        onChangeUsername={(_e, value) => setUsername(value)}
        passwordLabel="Password"
        passwordValue={password}
        onChangePassword={(_e, value) => setPassword(value)}
        isLoginButtonDisabled={isSubmitting}
        loginButtonLabel={isSubmitting ? 'Logging in...' : 'Log in'}
        onLoginButtonClick={handleSubmit}
      />
    </LoginPage>
  );
}
