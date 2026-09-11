import type { DeviceSetting, SettingDependency } from '@/api/types';

export type ChoiceOption = { name: string; label: string };

function settingDependencies(setting: DeviceSetting): SettingDependency[] {
  if (setting.dependencies.length > 0) {
    return setting.dependencies;
  }
  if (!setting.depends_on) return [];
  return [{ name: setting.depends_on, value: setting.depends_value }];
}

export function isVisible(
  setting: DeviceSetting,
  values: Record<string, string>,
): boolean {
  if (setting.hide_if_disabled && setting.disabled) return false;
  return settingDependencies(setting).every((dep) => values[dep.name] === dep.value);
}

export function isBooleanOn(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized === 'ON' || normalized === '1' || normalized === 'TRUE' || normalized === 'YES';
}

export function booleanOptions(): ChoiceOption[] {
  return [
    { name: 'ON', label: 'On' },
    { name: 'OFF', label: 'Off' },
  ];
}

function isOffishLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized === 'off' || normalized === 'disabled' || normalized === 'no';
}

function isOnishLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized === 'on' || normalized === 'enabled' || normalized === 'yes';
}

/** Keep binary toggles in a stable On → Off (or Enabled → Disabled) order. */
export function orderChoiceOptions(options: ChoiceOption[]): ChoiceOption[] {
  if (options.length !== 2) return options;
  const [a, b] = options;
  if (isOnishLabel(a.label) && isOffishLabel(b.label)) return options;
  if (isOffishLabel(a.label) && isOnishLabel(b.label)) return [b, a];
  return options;
}

export function choiceOptionsForSetting(setting: DeviceSetting): ChoiceOption[] {
  if (setting.options.length > 0) {
    return orderChoiceOptions(
      setting.options.map((option) => ({
        name: option.name,
        label: option.display_name || option.name,
      })),
    );
  }
  if (setting.kind === 'boolean') {
    return booleanOptions();
  }
  return [];
}

export function selectedChoiceValue(setting: DeviceSetting, value: string): string {
  if (setting.options.length > 0) {
    return value;
  }
  if (setting.kind === 'boolean') {
    return isBooleanOn(value) ? 'ON' : 'OFF';
  }
  return value;
}

export function displayValue(setting: DeviceSetting, value: string): string {
  if (setting.options.length > 0) {
    const option = setting.options.find((item) => item.name === value);
    if (option) return option.display_name || option.name;
  }
  if (setting.kind === 'boolean') {
    return isBooleanOn(value) ? 'On' : 'Off';
  }
  if (setting.kind === 'list') {
    const option = setting.options.find((item) => item.name === value);
    return option?.display_name || value || '—';
  }
  if (setting.kind === 'dual-range' && value.includes(',')) {
    const [low, high] = value.split(',');
    const unit = setting.units ? ` ${setting.units}` : '';
    return `${low} … ${high}${unit}`;
  }
  if (setting.kind === 'range' && setting.units) {
    return `${value} ${setting.units}`;
  }
  return value || '—';
}

/** Expected BluOS write target for tests and docs. */
export function writeStrategy(setting: DeviceSetting): 'bluos-get' | 'web-ui-post' {
  return setting.control_path ? 'bluos-get' : 'web-ui-post';
}

export function isDualRangeValid(setting: DeviceSetting, draft: string): boolean {
  const [lowRaw = '', highRaw = ''] = draft.split(',');
  const low = Number(lowRaw);
  const high = Number(highRaw);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return false;
  if (setting.min_value != null && low < setting.min_value) return false;
  if (setting.max_value != null && high > setting.max_value) return false;
  if (setting.min_range != null && high - low < setting.min_range) return false;
  return true;
}

// Patterns are scraped from the player's own web UI, which is untrusted input.
// A catastrophic-backtracking pattern does not throw, it hangs the tab, so bound
// both sides: long patterns are not applied, and long drafts are not tested.
const MAX_PATTERN_LENGTH = 200;
const MAX_VALIDATED_LENGTH = 256;

export function isTextValueValid(setting: DeviceSetting, draft: string): boolean {
  const trimmed = draft.trim();
  if (!trimmed) return false;
  if (!setting.pattern) return true;
  if (setting.pattern.length > MAX_PATTERN_LENGTH) return true;
  if (trimmed.length > MAX_VALIDATED_LENGTH) return false;
  try {
    return new RegExp(`^(?:${setting.pattern})$`).test(trimmed);
  } catch {
    return true;
  }
}
