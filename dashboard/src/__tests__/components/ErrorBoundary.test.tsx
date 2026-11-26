/**
 * Tests for the shared ErrorBoundary (issue #256).
 *
 * The boundary was extracted from App.tsx to src/components/ErrorBoundary.tsx so it can be
 * rendered here without dragging the whole page tree (chatbot/monaco Playground graph) into
 * the unit suite — same reason as ProtectedRoute. App.tsx hoists one instance around the whole
 * <Routes> tree (covering /login, /oauth/callback, ProtectedRoute, the providers and AppLayout)
 * while keeping the page-level instance inside AppLayout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary';
// Real i18next instance: the fallback renders t('errors.somethingWrong').
import '../../i18n';

function Boom(): ReactNode {
  throw new Error('boom');
}

/** Provider-shaped component that throws during its own render once it has content. */
function BrokenProvider({ children }: { children: ReactNode }): ReactNode {
  if (children) throw new Error('provider boom');
  return null;
}

describe('ErrorBoundary', () => {
  // React logs caught render errors through console.error, and jsdom re-reports the throw as an
  // uncaught ErrorEvent (its invokeGuardedCallback path); silence both in the suite output.
  const swallowErrorEvent = (event: ErrorEvent): void => event.preventDefault();

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.addEventListener('error', swallowErrorEvent);
  });

  afterEach(() => {
    window.removeEventListener('error', swallowErrorEvent);
    vi.mocked(console.error).mockRestore();
  });

  it('renders children when no error', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary>
          <div>ALL_GOOD</div>
        </ErrorBoundary>
      </MemoryRouter>,
    );

    expect(screen.getByText('ALL_GOOD')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('renders the fallback when a child render throws', () => {
    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </MemoryRouter>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('renders the fallback when a provider between the boundary and a page throws', () => {
    // Covers the hoisted placement rationale: a provider exception above AppLayout used to
    // blank the whole document.
    function Page() {
      return <div>PAGE_CONTENT</div>;
    }

    render(
      <MemoryRouter>
        <ErrorBoundary>
          <BrokenProvider>
            <Page />
          </BrokenProvider>
        </ErrorBoundary>
      </MemoryRouter>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('provider boom')).toBeInTheDocument();
    expect(screen.queryByText('PAGE_CONTENT')).not.toBeInTheDocument();
  });
});
