import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import type { DeviceSetting, DeviceSettingsResponse } from '@/api/types';
import { ApiError } from '@/api/types';
import {
  choiceOptionsForSetting,
  displayValue,
  isDualRangeValid,
  isTextValueValid,
  isVisible,
  selectedChoiceValue,
} from '@/lib/deviceSettings';

type SettingsPage = 'audio' | 'player';

interface DeviceSettingsPanelProps {
  deviceId: string;
}

export function DeviceSettingsPanel({ deviceId }: DeviceSettingsPanelProps) {
  const [page, setPage] = useState<SettingsPage>('audio');
  const [data, setData] = useState<DeviceSettingsResponse | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const ac = new AbortController();
    const key = `${deviceId}:${page}`;
    void (async () => {
      try {
        const response = await api.getSettings(deviceId, page, { signal: ac.signal });
        if (ac.signal.aborted) return;
        const next: Record<string, string> = {};
        for (const setting of response.settings) {
          next[setting.id] = setting.value;
        }
        setData(response);
        setValues(next);
        setDrafts({});
        setError(null);
        setLoadedFor(key);
      } catch (err) {
        if (ac.signal.aborted) return;
        setData(null);
        setValues({});
        setDrafts({});
        setLoadedFor(key);
        setError(
          err instanceof ApiError
            ? `${err.message} (${err.requestId})`
            : 'Failed to load settings',
        );
      }
    })();
    return () => ac.abort();
  }, [deviceId, page]);

  const loading = loadedFor !== `${deviceId}:${page}`;
  const visible = useMemo(() => {
    if (!data) return [];
    return data.settings.filter((setting) => isVisible(setting, values));
  }, [data, values]);

  const actions = visible.filter((setting) => setting.kind === 'button');
  const fields = visible.filter((setting) => setting.kind !== 'button');

  const write = async (setting: DeviceSetting, value: string) => {
    const current = values[setting.id] ?? setting.value;
    if (setting.kind !== 'button' && value === current) return;
    setBusyId(setting.id);
    setError(null);
    try {
      await api.setSetting(deviceId, setting.id, value);
      setValues((prev) => ({ ...prev, [setting.id]: value }));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[setting.id];
        return next;
      });
      if (setting.kind === 'button' || setting.refresh_after_write) {
        const response = await api.getSettings(deviceId, page);
        const next: Record<string, string> = {};
        for (const item of response.settings) {
          next[item.id] = item.value;
        }
        setData(response);
        setValues(next);
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? `${err.message} (${err.requestId})` : 'Failed to update setting',
      );
    } finally {
      setBusyId(null);
    }
  };

  const commitRange = (setting: DeviceSetting, raw: string) => {
    void write(setting, raw);
  };

  return (
    <section>
      <h3>Settings</h3>
      <div className="transport" style={{ marginTop: 8, marginBottom: 12 }}>
        <button
          type="button"
          className={page === 'audio' ? 'btn btn-primary' : 'btn'}
          onClick={() => setPage('audio')}
        >
          Audio
        </button>
        <button
          type="button"
          className={page === 'player' ? 'btn btn-primary' : 'btn'}
          onClick={() => setPage('player')}
        >
          Player
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {loading ? <div className="empty">Loading settings…</div> : null}
      {!loading && fields.length === 0 && actions.length === 0 ? (
        <div className="empty">No settings on this page</div>
      ) : null}
      {!loading && fields.length > 0 ? (
        <ul className="list">
          {fields.map((setting) => {
            const value = values[setting.id] ?? setting.value;
            const draft = drafts[setting.id] ?? value;
            const disabled = setting.disabled || busyId === setting.id;
            const tip = setting.explanation || setting.description || undefined;

            if (setting.kind === 'boolean' || setting.kind === 'list') {
              const options = choiceOptionsForSetting(setting);
              const selected = selectedChoiceValue(setting, value);
              const currentLabel =
                options.find((option) => option.name === selected)?.label ||
                displayValue(setting, value);
              return (
                <li key={setting.id} title={tip}>
                  <span>
                    {setting.display_name}
                    <div className="card-meta">{currentLabel}</div>
                  </span>
                  <span className="queue-move">
                    {options.map((option) => (
                      <button
                        key={option.name}
                        type="button"
                        className={
                          option.name === selected
                            ? 'btn btn-primary btn-compact'
                            : 'btn btn-compact'
                        }
                        disabled={disabled || option.name === selected}
                        onClick={() => void write(setting, option.name)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </span>
                </li>
              );
            }

            if (
              setting.kind === 'range' &&
              setting.min_value != null &&
              setting.max_value != null
            ) {
              return (
                <li key={setting.id} title={tip}>
                  <span>
                    {setting.display_name}
                    <div className="card-meta">{displayValue(setting, draft)}</div>
                  </span>
                  <div className="volume-row" style={{ flex: '1 1 12rem', minWidth: 0 }}>
                    <input
                      type="range"
                      min={setting.min_value}
                      max={setting.max_value}
                      step={setting.step ?? 1}
                      value={Number(draft) || 0}
                      disabled={disabled}
                      aria-label={setting.display_name}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [setting.id]: e.target.value }))
                      }
                      onPointerUp={(e) =>
                        commitRange(setting, (e.target as HTMLInputElement).value)
                      }
                      onBlur={(e) => commitRange(setting, e.target.value)}
                    />
                  </div>
                </li>
              );
            }

            if (setting.kind === 'dual-range') {
              const [low = '', high = ''] = draft.split(',');
              const dualOk = isDualRangeValid(setting, draft);
              return (
                <li key={setting.id} title={tip}>
                  <span>
                    {setting.display_name}
                    <div className="card-meta">{displayValue(setting, value)}</div>
                  </span>
                  <span className="queue-move">
                    <input
                      type="number"
                      className="settings-num"
                      value={low}
                      min={setting.min_value ?? undefined}
                      max={setting.max_value ?? undefined}
                      disabled={disabled}
                      aria-label={`${setting.display_name} low`}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [setting.id]: `${e.target.value},${high}`,
                        }))
                      }
                    />
                    <input
                      type="number"
                      className="settings-num"
                      value={high}
                      min={setting.min_value ?? undefined}
                      max={setting.max_value ?? undefined}
                      disabled={disabled}
                      aria-label={`${setting.display_name} high`}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [setting.id]: `${low},${e.target.value}`,
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="btn btn-compact"
                      disabled={disabled || draft === value || !dualOk}
                      title={dualOk ? undefined : 'Keep both limits in range with enough span'}
                      onClick={() => void write(setting, draft)}
                    >
                      Set
                    </button>
                  </span>
                </li>
              );
            }

            if (setting.kind === 'text') {
              const textOk = isTextValueValid(setting, draft);
              return (
                <li key={setting.id} title={tip}>
                  <span>
                    {setting.display_name}
                    {setting.disabled ? (
                      <div className="card-meta">{value || '—'}</div>
                    ) : (
                      <input
                        type="text"
                        className="settings-text"
                        value={draft}
                        disabled={disabled}
                        aria-label={setting.display_name}
                        onChange={(e) =>
                          setDrafts((prev) => ({ ...prev, [setting.id]: e.target.value }))
                        }
                      />
                    )}
                  </span>
                  {!setting.disabled ? (
                    <button
                      type="button"
                      className="btn"
                      disabled={disabled || draft === value || !textOk}
                      title={
                        textOk ? undefined : setting.pattern_error || 'Enter a valid value'
                      }
                      onClick={() => void write(setting, draft)}
                    >
                      Update
                    </button>
                  ) : (
                    <span className="card-meta">Locked</span>
                  )}
                </li>
              );
            }

            return (
              <li key={setting.id} title={tip}>
                <span>
                  {setting.display_name}
                  <div className="card-meta">{displayValue(setting, value)}</div>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {!loading && actions.length > 0 ? (
        <div className="transport" style={{ marginTop: 12 }}>
          {actions.map((setting) => (
            <button
              key={setting.id}
              type="button"
              className="btn btn-danger"
              disabled={setting.disabled || busyId === setting.id}
              title={setting.explanation || setting.description || undefined}
              onClick={() => {
                if (window.confirm(`${setting.display_name}?`)) {
                  void write(setting, '1');
                }
              }}
            >
              {setting.display_name}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
