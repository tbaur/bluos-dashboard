import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceSettingsPanel } from '@/components/DeviceSettingsPanel';
import type { DeviceSettingsResponse } from '@/api/types';
import { ApiError } from '@/api/types';

const getSettings = vi.fn();
const setSetting = vi.fn();

vi.mock('@/api/client', () => ({
  api: {
    getSettings: (...args: unknown[]) => getSettings(...args),
    setSetting: (...args: unknown[]) => setSetting(...args),
  },
}));

function setting(
  partial: Partial<DeviceSettingsResponse['settings'][number]> & { id: string },
): DeviceSettingsResponse['settings'][number] {
  return {
    name: partial.id,
    display_name: partial.id,
    kind: 'boolean',
    value: '',
    description: '',
    explanation: '',
    disabled: false,
    control_path: '',
    min_value: null,
    max_value: null,
    step: null,
    units: '',
    options: [],
    dependencies: [],
    depends_on: '',
    depends_value: '',
    hide_if_disabled: false,
    min_range: null,
    pattern: '',
    pattern_error: '',
    refresh_after_write: false,
    ...partial,
  };
}

const audioPage: DeviceSettingsResponse = {
  page_id: 'audio',
  settings: [
    setting({
      id: 'eq-switch',
      display_name: 'Tone Controls',
      kind: 'boolean',
      value: 'OFF',
      control_path: '/alsa_setting',
    }),
    setting({
      id: 'eq-treble',
      display_name: 'Treble',
      kind: 'range',
      value: '0',
      control_path: '/alsa_setting',
      min_value: -6,
      max_value: 6,
      step: 1,
      units: 'dB',
      depends_on: 'eq-switch',
      depends_value: 'ON',
    }),
    setting({
      id: 'subwoofer',
      display_name: 'Subwoofer',
      kind: 'boolean',
      value: 'default',
      description: 'Off',
      control_path: '/audiomodes',
      options: [
        { name: 'default', display_name: 'Off' },
        { name: 'withsub', display_name: 'On' },
      ],
    }),
    setting({
      id: 'channelMode',
      display_name: 'Output mode',
      kind: 'list',
      value: 'default',
      description: 'Stereo',
      control_path: '/audiomodes',
      options: [
        { name: 'default', display_name: 'Stereo' },
        { name: 'left', display_name: 'Left' },
        { name: 'right', display_name: 'Right' },
        { name: 'mono', display_name: 'Mono' },
      ],
    }),
    setting({
      id: 'volumeLimits',
      display_name: 'Volume limits (dB)',
      kind: 'dual-range',
      value: '-90,-10',
      units: 'dB',
      min_value: -90,
      max_value: 0,
      min_range: 30,
      control_path: '',
    }),
    setting({
      id: 'reset',
      display_name: 'Reset All',
      kind: 'button',
      control_path: '/alsa_setting',
    }),
  ],
};

const playerPage: DeviceSettingsResponse = {
  page_id: 'player',
  settings: [
    setting({
      id: 'nodename',
      display_name: 'Room name',
      kind: 'text',
      value: 'Kitchen',
      control_path: '/Name',
    }),
    setting({
      id: 'ledbrightness',
      display_name: 'Indicator brightness',
      kind: 'list',
      value: 'default',
      control_path: '/setting',
      options: [
        { name: 'default', display_name: 'Normal' },
        { name: 'dim', display_name: 'Dim' },
        { name: 'off', display_name: 'Off' },
      ],
    }),
  ],
};

describe('DeviceSettingsPanel', () => {
  beforeEach(() => {
    getSettings.mockReset();
    setSetting.mockReset();
    getSettings.mockResolvedValue(audioPage);
    setSetting.mockResolvedValue(undefined);
  });

  it('renders On before Off for subwoofer and highlights the active Off choice', async () => {
    render(<DeviceSettingsPanel deviceId="player-kitchen" />);
    await screen.findByText('Subwoofer');

    const subwooferRow = screen.getByText('Subwoofer').closest('li');
    expect(subwooferRow).toBeTruthy();
    const buttons = Array.from(subwooferRow!.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['On', 'Off']);
    expect(subwooferRow!.querySelector('.btn-primary')).toHaveTextContent('Off');
  });

  it('hides Treble until Tone Controls is On', async () => {
    render(<DeviceSettingsPanel deviceId="player-kitchen" />);
    await screen.findByText('Tone Controls');
    expect(screen.queryByText('Treble')).not.toBeInTheDocument();

    const toneRow = screen.getByText('Tone Controls').closest('li')!;
    fireEvent.click(within(toneRow).getByRole('button', { name: 'On' }));
    await waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith(
        'player-kitchen',
        'eq-switch',
        'ON',
      );
    });
    await screen.findByText('Treble');
  });

  it('writes channelMode left with control_path /audiomodes', async () => {
    render(<DeviceSettingsPanel deviceId="player-kitchen" />);
    await screen.findByText('Output mode');

    fireEvent.click(screen.getByRole('button', { name: 'Left' }));
    await waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith(
        'player-kitchen',
        'channelMode',
        'left',
      );
    });
  });

  it('writes plain boolean via /alsa_setting', async () => {
    render(<DeviceSettingsPanel deviceId="player-kitchen" />);
    await screen.findByText('Tone Controls');

    const toneRow = screen.getByText('Tone Controls').closest('li')!;
    fireEvent.click(within(toneRow).getByRole('button', { name: 'On' }));
    await waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith(
        'player-kitchen',
        'eq-switch',
        'ON',
      );
    });
  });

  it('commits range on pointer up with control_path', async () => {
    getSettings.mockResolvedValue({
      page_id: 'audio',
      settings: [
        setting({
          id: 'eq-switch',
          display_name: 'Tone Controls',
          kind: 'boolean',
          value: 'ON',
          control_path: '/alsa_setting',
        }),
        setting({
          id: 'eq-treble',
          display_name: 'Treble',
          kind: 'range',
          value: '0',
          control_path: '/alsa_setting',
          min_value: -6,
          max_value: 6,
          step: 1,
          units: 'dB',
          depends_on: 'eq-switch',
          depends_value: 'ON',
        }),
      ],
    });
    render(<DeviceSettingsPanel deviceId="player-kitchen" />);
    const slider = await screen.findByLabelText('Treble');
    fireEvent.change(slider, { target: { value: '2' } });
    fireEvent.pointerUp(slider, { target: slider });
    await waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith(
        'player-kitchen',
        'eq-treble',
        '2',
      );
    });
  });

  it('writes dual-range via empty control_path (web UI)', async () => {
    render(<DeviceSettingsPanel deviceId="player-kitchen" />);
    await screen.findByText('Volume limits (dB)');

    fireEvent.change(screen.getByLabelText('Volume limits (dB) low'), {
      target: { value: '-80' },
    });
    fireEvent.change(screen.getByLabelText('Volume limits (dB) high'), {
      target: { value: '-5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    await waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith(
        'player-kitchen',
        'volumeLimits',
        '-80,-5',
      );
    });
  });

  it('writes text Room name with /Name after Update', async () => {
    getSettings.mockImplementation(async (_id: string, page: string) =>
      page === 'player' ? playerPage : audioPage,
    );
    render(<DeviceSettingsPanel deviceId="player-kitchen" />);
    fireEvent.click(screen.getByRole('button', { name: 'Player' }));
    await screen.findByLabelText('Room name');

    fireEvent.change(screen.getByLabelText('Room name'), {
      target: { value: 'Kitchen Speakers' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith(
        'player-kitchen',
        'nodename',
        'Kitchen Speakers',
      );
    });
  });

  it('confirms before Reset All and refreshes the page', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DeviceSettingsPanel deviceId="player-kitchen" />);
    await screen.findByRole('button', { name: 'Reset All' });

    fireEvent.click(screen.getByRole('button', { name: 'Reset All' }));
    await waitFor(() => {
      expect(setSetting).toHaveBeenCalledWith(
        'player-kitchen',
        'reset',
        '1',
      );
    });
    expect(confirm).toHaveBeenCalled();
    expect(getSettings.mock.calls.filter((c) => c[1] === 'audio').length).toBeGreaterThanOrEqual(2);
    confirm.mockRestore();
  });

  it('does not write Reset All when confirm is cancelled', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DeviceSettingsPanel deviceId="player-kitchen" />);
    await screen.findByRole('button', { name: 'Reset All' });
    fireEvent.click(screen.getByRole('button', { name: 'Reset All' }));
    expect(setSetting).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('does not write volume limits when the span is below minRange', async () => {
    render(<DeviceSettingsPanel deviceId="player-kitchen" />);
    await screen.findByText('Volume limits (dB)');

    fireEvent.change(screen.getByLabelText('Volume limits (dB) low'), {
      target: { value: '-20' },
    });
    fireEvent.change(screen.getByLabelText('Volume limits (dB) high'), {
      target: { value: '0' },
    });
    expect(screen.getByRole('button', { name: 'Set' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('shows Locked for a HomeKit-locked room name', async () => {
    getSettings.mockImplementation(async (_id: string, page: string) =>
      page === 'player'
        ? {
            page_id: 'player',
            settings: [
              setting({
                id: 'nodename',
                display_name: 'Room name',
                kind: 'text',
                value: 'Kitchen Speakers',
                disabled: true,
                control_path: '/Name',
                explanation: 'Locked by Apple Home',
              }),
            ],
          }
        : audioPage,
    );
    render(<DeviceSettingsPanel deviceId="player-kitchen" />);
    fireEvent.click(screen.getByRole('button', { name: 'Player' }));
    await screen.findByText('Locked');
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Room name')).not.toBeInTheDocument();
  });

  it('surfaces ApiError from failed writes', async () => {
    setSetting.mockRejectedValue(
      new ApiError(502, {
        error: 'bluos_control_failed',
        message: 'BluOS setting failed',
        code: 'bluos_control_failed',
        request_id: 'req-1',
      }),
    );
    render(<DeviceSettingsPanel deviceId="player-kitchen" />);
    await screen.findByText('Output mode');
    fireEvent.click(screen.getByRole('button', { name: 'Left' }));
    await screen.findByText(/BluOS setting failed \(req-1\)/);
  });
});
