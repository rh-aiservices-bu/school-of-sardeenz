/**
 * Render probes for the dashboard unit-test render tree (issue #176).
 *
 * One case per React-consuming package family that the test config has to keep
 * on a single React copy (the dashboard-local 18.3.1): PatternFly core, icons,
 * table and charts (victory), nivo (+ @react-spring), react-markdown (the
 * chatbot's renderer, not yet imported by `src/`), react-router, react-i18next
 * and @tanstack/react-query, plus a real app component. The assertions are
 * deliberately shallow — the guard is that the render does not throw a
 * cross-version error ("Objects are not valid as a React child", "Cannot read
 * properties of null (reading 'useX')").
 *
 * Adding a React-consuming dependency? Add its family to
 * `test.server.deps.inline` in vitest.config.ts (and an ESM-entry alias if it
 * only ships CJS), then add a case here. See docs/development/patternfly.md.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Link, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@patternfly/react-core';
import { RhUiCheckCircleFillIcon } from '@patternfly/react-icons';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { Chart, ChartBar } from '@patternfly/react-charts/victory';
import { Bar } from '@nivo/bar';
import Markdown from 'react-markdown';
import { ModelLifecycleState } from '@sardeenz/types';
import { StateLabel } from '../components/StateLabel';
// Installs the app's real i18next instance (and initReactI18next) exactly as
// main.tsx does at boot, so `t()` resolves the bundled resources.
import '../i18n';

describe('render probes: PatternFly', () => {
  it('renders a Button (react-core)', () => {
    render(<Button variant="primary">Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
  });

  it('renders an icon (react-icons)', () => {
    const { container } = render(<RhUiCheckCircleFillIcon />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders a Table (react-table)', () => {
    render(
      <Table aria-label="render probe">
        <Thead>
          <Tr>
            <Th>Name</Th>
          </Tr>
        </Thead>
        <Tbody>
          <Tr>
            <Td>cell</Td>
          </Tr>
        </Tbody>
      </Table>,
    );
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('cell')).toBeInTheDocument();
  });

  it('renders a victory chart (react-charts/victory)', () => {
    const { container } = render(
      <Chart ariaTitle="render probe" height={200} width={300}>
        <ChartBar
          data={[
            { x: 'a', y: 1 },
            { x: 'b', y: 2 },
          ]}
        />
      </Chart>,
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('render probes: nivo', () => {
  it('renders a Bar with explicit dimensions (@nivo/bar + @react-spring)', () => {
    const { container } = render(
      <Bar
        width={400}
        height={300}
        data={[
          { label: 'a', value: 1 },
          { label: 'b', value: 2 },
        ]}
        keys={['value']}
        indexBy="label"
      />,
    );
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

describe('render probes: router, i18n, react-query, markdown', () => {
  it('renders MemoryRouter + Link + Route and navigates', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <Link to="/probe">go to probe</Link>
                <div>home</div>
              </>
            }
          />
          <Route path="/probe" element={<div>probe page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('link', { name: 'go to probe' }));
    expect(await screen.findByText('probe page')).toBeInTheDocument();
  });

  it('renders a useTranslation component against the real i18n instance', async () => {
    function Translated() {
      const { t } = useTranslation('common');
      return <div>{t('loading')}</div>;
    }
    render(<Translated />);
    expect(await screen.findByText('Loading...')).toBeInTheDocument();
  });

  it('renders a useQuery component (react-query)', async () => {
    function QueryProbe() {
      const { data, isSuccess } = useQuery({
        queryKey: ['render-probe'],
        queryFn: () => Promise.resolve('query ok'),
      });
      return <div>{isSuccess ? data : 'pending'}</div>;
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <QueryProbe />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('query ok')).toBeInTheDocument();
  });

  it('renders react-markdown', () => {
    render(<Markdown>{'# heading'}</Markdown>);
    expect(screen.getByRole('heading', { level: 1, name: 'heading' })).toBeInTheDocument();
  });
});

describe('render probes: app components', () => {
  it('renders StateLabel (PatternFly Label + icons + app i18n resources)', () => {
    const { container } = render(<StateLabel state={ModelLifecycleState.SLEEPING} />);
    expect(screen.getByText('Sleeping')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
