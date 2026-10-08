import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ status: 200, ok: true }),
  );
});

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

describe('App routes', () => {
  it('renders the fleet page at /', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Fleet')).toBeInTheDocument();
  });

  it('shows the token form when the session probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText('API token')).toBeInTheDocument();
    expect(screen.queryByText('Fleet')).not.toBeInTheDocument();
  });

  it('renders the house page at /house', async () => {
    render(
      <MemoryRouter initialEntries={['/house']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText('House')).toBeInTheDocument();
  });
});
