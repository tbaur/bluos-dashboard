import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionGate } from '@/components/SessionGate';

const listDevices = vi.fn();
const openSession = vi.fn();

vi.mock('@/api/client', () => ({
  api: {
    listDevices: (...args: unknown[]) => listDevices(...args),
    openSession: (...args: unknown[]) => openSession(...args),
  },
}));

async function apiError(status: number) {
  const { ApiError } = await import('@/api/types');
  return new ApiError(status, { error: 'x', message: 'x', code: 'x', request_id: '-' });
}

function renderGate() {
  return render(
    <SessionGate>
      <div>Dashboard</div>
    </SessionGate>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('SessionGate token form', () => {
  it('explains a wrong token and keeps the form', async () => {
    listDevices.mockRejectedValue(await apiError(401));
    openSession.mockRejectedValue(await apiError(401));
    renderGate();

    const input = await screen.findByLabelText('API token');
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That token does not match the one set on the server.',
    );
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('says when the server cannot be reached during sign-in', async () => {
    listDevices.mockRejectedValue(await apiError(401));
    openSession.mockRejectedValue(new TypeError('Failed to fetch'));
    renderGate();

    fireEvent.change(await screen.findByLabelText('API token'), { target: { value: 'token' } });
    fireEvent.submit(screen.getByLabelText('API token').closest('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the dashboard');
  });

  it('shows and hides the token', async () => {
    listDevices.mockRejectedValue(await apiError(401));
    renderGate();

    const input = await screen.findByLabelText('API token');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(input).toHaveAttribute('type', 'text');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('opens the dashboard once the token is accepted', async () => {
    listDevices.mockRejectedValue(await apiError(401));
    openSession.mockResolvedValue(undefined);
    renderGate();

    fireEvent.change(await screen.findByLabelText('API token'), { target: { value: 'right' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(openSession).toHaveBeenCalledWith('right');
  });
});

describe('SessionGate when the API is down', () => {
  it('retries on request and opens once the API answers', async () => {
    listDevices.mockRejectedValueOnce(await apiError(502)).mockResolvedValue({});
    renderGate();

    fireEvent.click(await screen.findByRole('button', { name: 'Try again now' }));
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('retries on its own every few seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listDevices.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({});
    renderGate();

    await screen.findByRole('heading', { name: 'Can’t reach the dashboard' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(listDevices).toHaveBeenCalledTimes(2);
  });
});
