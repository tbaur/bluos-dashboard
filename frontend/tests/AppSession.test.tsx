import { render, screen } from '@testing-library/react';
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

describe('built-in API token', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets the session cookie before the fleet renders', async () => {
    let resolveFetch: (value: { ok: boolean; status: number }) => void = () => undefined;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(screen.queryByText('Fleet')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/session',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: {
          Authorization: 'Bearer dev-token',
          'X-BSD-Request': '1',
        },
      }),
    );

    resolveFetch({ ok: true, status: 204 });
    expect(await screen.findByText('Fleet')).toBeInTheDocument();
  });

  it('asks for a token when the built-in one is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );

    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText('API token')).toBeInTheDocument();
    expect(screen.queryByText('Fleet')).not.toBeInTheDocument();
  });
});
