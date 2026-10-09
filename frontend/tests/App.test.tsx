import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';

function ok() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ devices: [], discovered_at: null, discovery_method: '' }),
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok()));
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

function renderAt(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('App routes', () => {
  it('renders the fleet page at /', async () => {
    renderAt();
    expect(await screen.findByText('Fleet')).toBeInTheDocument();
  });

  it('renders the house page at /house', async () => {
    renderAt('/house');
    expect(await screen.findByText('House')).toBeInTheDocument();
  });

  it('does not ask for a token when the API is only unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderAt();
    expect(await screen.findByRole('heading', { name: 'Can’t reach the dashboard' })).toBeInTheDocument();
    expect(screen.queryByLabelText('API token')).not.toBeInTheDocument();
  });
});
