import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';

vi.mock('@/api/auth', () => ({
  apiToken: 'dev-token',
}));

vi.mock('@/hooks/useLiveFleet', () => ({
  useLiveFleet: () => undefined,
}));

vi.mock('@/components/FleetPage', () => ({
  FleetPage: () => <div>Fleet</div>,
}));

vi.mock('@/components/HousePage', () => ({
  HousePage: () => <div>House</div>,
}));

vi.mock('@/components/PlayerDetailPage', () => ({
  PlayerDetailPage: () => <div>Player</div>,
}));

function respond(status: number) {
  return {
    ok: status < 400,
    status,
    statusText: '',
    headers: new Headers(),
    json: async () =>
      status === 401
        ? { error: 'unauthorized', message: 'Valid API token required', code: 'unauthorized' }
        : { devices: [], discovered_at: null, discovery_method: '' },
  };
}

function call(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, method: init.method ?? 'GET', auth: new Headers(init.headers).get('Authorization') };
}

function renderApp() {
  return render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
}

describe('built-in API token', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets the session cookie before the fleet renders', async () => {
    let resolveFetch: (value: unknown) => void = () => undefined;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    expect(screen.queryByText('Fleet')).not.toBeInTheDocument();
    expect(call(fetchMock, 0)).toEqual({
      url: '/api/v1/session',
      method: 'POST',
      auth: 'Bearer dev-token',
    });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' });

    resolveFetch(respond(204));
    expect(await screen.findByText('Fleet')).toBeInTheDocument();
  });

  it('opens the dashboard when the server has no token set', async () => {
    // /session refuses when no token is configured; /devices is open.
    const fetchMock = vi.fn().mockResolvedValueOnce(respond(401)).mockResolvedValue(respond(200));
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    expect(await screen.findByText('Fleet')).toBeInTheDocument();
    expect(call(fetchMock, 1).url).toBe('/api/v1/devices');
  });

  it('asks for a token when the built-in one is rejected, and sends the typed one', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(401))
      .mockResolvedValueOnce(respond(401))
      .mockResolvedValueOnce(respond(204));
    vi.stubGlobal('fetch', fetchMock);

    renderApp();

    fireEvent.change(await screen.findByLabelText('API token'), {
      target: { value: ' typed-token ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Fleet')).toBeInTheDocument();
    expect(call(fetchMock, 2)).toEqual({
      url: '/api/v1/session',
      method: 'POST',
      auth: 'Bearer typed-token',
    });
  });
});
