import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { formatClock } from '@/lib/clock';
import { SeekBar } from '@/components/SeekBar';

describe('formatClock', () => {
  it('formats clocks', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(90)).toBe('1:30');
  });
});

describe('SeekBar', () => {

  it('renders a non-seekable bar when seeking is disabled', () => {
    render(<SeekBar initialSecs={30} totlen={240} playing={false} />);
    expect(screen.queryByRole('slider', { name: 'Seek' })).not.toBeInTheDocument();
    expect(screen.getByText('0:30')).toBeInTheDocument();
    expect(screen.getByText('4:00')).toBeInTheDocument();
  });

  it('keeps the fill when a nearby poll arrives', () => {
    const { container, rerender } = render(
      <SeekBar initialSecs={30} totlen={240} playing={false} />,
    );
    const fill = container.querySelector('.dossier-progress-fill');
    expect(fill).toHaveStyle({ transform: 'scaleX(0.125)' });
    rerender(<SeekBar initialSecs={31} totlen={240} playing={false} />);
    expect(fill).toHaveStyle({ transform: 'scaleX(0.125)' });
    expect(screen.getByText('0:30')).toBeInTheDocument();
  });

  it('snaps the fill after a real seek', () => {
    const { container, rerender } = render(
      <SeekBar initialSecs={30} totlen={240} playing={false} />,
    );
    rerender(<SeekBar initialSecs={120} totlen={240} playing={false} />);
    expect(container.querySelector('.dossier-progress-fill')).toHaveStyle({
      transform: 'scaleX(0.5)',
    });
    expect(screen.getByText('2:00')).toBeInTheDocument();
  });

  it('keeps a drag when a nearby status sample arrives', () => {
    const { container, rerender } = render(
      <SeekBar initialSecs={30} totlen={240} playing={false} canSeek onSeek={vi.fn()} />,
    );
    const slider = screen.getByRole('slider', { name: 'Seek' });
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: '80' } });
    rerender(<SeekBar initialSecs={31} totlen={240} playing={false} canSeek onSeek={vi.fn()} />);
    expect(container.querySelector('.dossier-progress-fill')).toHaveStyle({
      transform: `scaleX(${80 / 240})`,
    });
    expect(slider).toHaveAttribute('aria-valuetext', '1:20 of 4:00');
    fireEvent.pointerUp(slider);
    expect(container.querySelector('.dossier-progress-fill')).toHaveStyle({
      transform: `scaleX(${80 / 240})`,
    });
    expect(slider).toHaveAttribute('aria-valuetext', '1:20 of 4:00');
  });

  it('commits seek on change', () => {
    vi.useFakeTimers();
    try {
      const onSeek = vi.fn();
      render(
        <SeekBar initialSecs={10} totlen={100} playing={false} canSeek onSeek={onSeek} />,
      );
      fireEvent.change(screen.getByRole('slider', { name: 'Seek' }), {
        target: { value: '40' },
      });
      vi.advanceTimersByTime(100);
      expect(onSeek).toHaveBeenCalledWith(40);
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances continuously while playing', () => {
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    try {
      const { container } = render(<SeekBar initialSecs={30} totlen={120} playing />);
      const fill = container.querySelector('.dossier-progress-fill');
      expect(fill).toHaveStyle({ transform: 'scaleX(0.25)' });
      now = 10_500;
      frames.at(-1)?.(now);
      expect(fill).toHaveStyle({ transform: `scaleX(${30.5 / 120})` });
      expect(screen.getByText('0:30')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
