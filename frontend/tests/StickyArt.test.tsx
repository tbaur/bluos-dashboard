import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StickyArt } from '@/components/StickyArt';

describe('StickyArt', () => {
  it('keeps the last image when src goes empty', () => {
    const { rerender } = render(
      <StickyArt src="/api/v1/devices/a/art" empty={<span>empty</span>} />,
    );
    expect(screen.getByRole('presentation')).toHaveAttribute('src', '/api/v1/devices/a/art');
    rerender(<StickyArt src="" empty={<span>empty</span>} />);
    expect(screen.getByRole('presentation')).toHaveAttribute('src', '/api/v1/devices/a/art');
    expect(screen.queryByText('empty')).not.toBeInTheDocument();
  });
});
