import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppMenu } from '@/components/AppMenu';
import { useFleetStore } from '@/store/fleetStore';

const refresh = vi.fn().mockResolvedValue(undefined);

function renderMenu(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppMenu />
      <Routes>
        <Route path="/" element={<p>fleet page</p>} />
        <Route path="/house" element={<p>house page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function menuButton() {
  return screen.getByRole('button', { name: 'Menu' });
}

describe('AppMenu', () => {
  beforeEach(() => {
    refresh.mockClear();
    useFleetStore.setState({
      devices: [],
      refreshing: false,
      discoveryMethod: 'mdns+lsdp',
      refresh,
    });
  });

  it('starts closed and opens on tap', () => {
    renderMenu();
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument();

    fireEvent.click(menuButton());

    expect(menuButton()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Fleet' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'House' })).not.toHaveAttribute('aria-current');
    expect(screen.getByText('0 players found via mDNS + LSDP')).toBeInTheDocument();
  });

  it('rescans the network from the menu', () => {
    renderMenu();
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('button', { name: 'Rescan network' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the scan in progress and blocks a second one', () => {
    useFleetStore.setState({ refreshing: true });
    renderMenu();
    fireEvent.click(menuButton());
    expect(screen.getByRole('button', { name: 'Scanning…' })).toBeDisabled();
  });

  it('navigates and closes when a page is chosen', () => {
    renderMenu();
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('link', { name: 'House' }));
    expect(screen.getByText('house page')).toBeInTheDocument();
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on Escape and returns focus to the button', () => {
    renderMenu();
    fireEvent.click(menuButton());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(menuButton()).toHaveFocus();
  });

  it('closes on a tap outside the menu', () => {
    renderMenu();
    fireEvent.click(menuButton());
    fireEvent.pointerDown(screen.getByText('fleet page'));
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('stays open for taps inside the panel', () => {
    renderMenu();
    fireEvent.click(menuButton());
    fireEvent.pointerDown(screen.getByRole('navigation', { name: 'Pages' }));
    expect(menuButton()).toHaveAttribute('aria-expanded', 'true');
  });
});
