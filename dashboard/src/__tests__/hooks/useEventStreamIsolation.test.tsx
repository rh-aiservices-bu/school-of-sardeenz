/**
 * Context-isolation guard for the two EventStream surfaces (#255).
 *
 * The SSE producer appends to `events` on every message but only changes `status` on connection
 * transitions, so a status-only consumer (every polling data hook, the degraded banner, the
 * metrics page) must not re-render when the events array grows. The two contexts are rendered
 * here the way `App.tsx`'s `EventStreamProvider` nests them, driven by an explicit rerender
 * instead of a live EventSource. The reader elements are created once per test and reused, so a
 * rerender only changes the provider values — exactly like the app, where the provider re-renders
 * from its own state while its `children` element stays the same.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ClusterEventType, type ControlPlaneComponents } from '@sardeenz/types';
import {
  EventStreamEventsContext,
  EventStreamStatusContext,
  useEventStreamEvents,
  useEventStreamStatus,
  type ConnectionStatus,
} from '../../hooks/useEventStream';

type ClusterEvent = ControlPlaneComponents['schemas']['ClusterEvent'];

const FIRST_EVENT: ClusterEvent = {
  type: ClusterEventType.WORKER_JOINED,
  timestamp: '2026-01-01T00:00:00.000Z',
};
const SECOND_EVENT: ClusterEvent = {
  type: ClusterEventType.WORKER_LEFT,
  timestamp: '2026-01-01T00:00:01.000Z',
};

function Providers({
  status,
  events,
  children,
}: {
  status: ConnectionStatus;
  events: ClusterEvent[];
  children: ReactNode;
}) {
  return (
    <EventStreamStatusContext.Provider value={status}>
      <EventStreamEventsContext.Provider value={events}>
        {children}
      </EventStreamEventsContext.Provider>
    </EventStreamStatusContext.Provider>
  );
}

function StatusReader({ onRender }: { onRender: () => void }) {
  const status = useEventStreamStatus();
  onRender();
  return <div>status: {status}</div>;
}

function EventsReader({ onRender }: { onRender: () => void }) {
  const events = useEventStreamEvents();
  onRender();
  return <div>events: {events.length}</div>;
}

describe('EventStream context split', () => {
  it('does not re-render a status-only consumer when only the events array grows', () => {
    const statusRenders = vi.fn();
    const eventsRenders = vi.fn();
    const readers = (
      <>
        <StatusReader onRender={statusRenders} />
        <EventsReader onRender={eventsRenders} />
      </>
    );
    const tree = (events: ClusterEvent[]) => (
      <Providers status="connected" events={events}>
        {readers}
      </Providers>
    );

    const { rerender, getByText } = render(tree([]));
    expect(statusRenders).toHaveBeenCalledTimes(1);
    expect(eventsRenders).toHaveBeenCalledTimes(1);

    rerender(tree([FIRST_EVENT]));
    expect(statusRenders).toHaveBeenCalledTimes(1);
    expect(eventsRenders).toHaveBeenCalledTimes(2);
    expect(getByText('events: 1')).toBeInTheDocument();

    rerender(tree([SECOND_EVENT, FIRST_EVENT]));
    expect(statusRenders).toHaveBeenCalledTimes(1);
    expect(eventsRenders).toHaveBeenCalledTimes(3);
    expect(getByText('status: connected')).toBeInTheDocument();
  });

  it('re-renders the status-only consumer when the connection status changes', () => {
    const statusRenders = vi.fn();
    const readers = <StatusReader onRender={statusRenders} />;
    const tree = (status: ConnectionStatus) => (
      <Providers status={status} events={[]}>
        {readers}
      </Providers>
    );

    const { rerender, getByText } = render(tree('connected'));
    rerender(tree('degraded'));
    expect(statusRenders).toHaveBeenCalledTimes(2);
    expect(getByText('status: degraded')).toBeInTheDocument();
  });

  it('gives the events consumer the newest array', () => {
    const { getByText } = render(
      <Providers status="connected" events={[SECOND_EVENT, FIRST_EVENT]}>
        <EventsReader onRender={() => undefined} />
      </Providers>,
    );
    expect(getByText('events: 2')).toBeInTheDocument();
  });
});
