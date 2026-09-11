export type SyncRole = 'primary' | 'synced' | 'standalone';

/** Reachability, decided by our poller — not by the device. */
export type PlayerReachability = 'online' | 'offline';

/**
 * BluOS transport state. The known values get autocomplete and typo-checking;
 * the open `string` arm is deliberate, because this is copied verbatim out of
 * device XML and a firmware revision may report something new.
 */
export type PlayerState =
  | 'play'
  | 'pause'
  | 'stop'
  | 'stream'
  | 'connecting'
  | (string & {});

export interface PlayerStatus {
  id: string;
  ip: string;
  /** BluOS API port; defaults to 11000 when omitted (legacy clients). */
  port?: number;
  endpoint?: string;
  name: string;
  model: string;
  brand: string;
  full_model: string;
  /** CI multi-zone index (1-based); omitted/null for ordinary single-zone players. */
  zone?: number | null;
  device_class: string;
  mac: string;
  status: PlayerReachability;
  state: PlayerState;
  service: string;
  service_id: string;
  volume: number;
  muted: boolean;
  db: string;
  fw: string;
  master: string;
  group: string;
  group_volume: number | null;
  slaves: string[];
  sync_role: SyncRole;
  battery: string | null;
  track: string;
  artist: string;
  album: string;
  quality: string;
  stream_format: string;
  image: string;
  secs: number;
  totlen: number;
  can_seek: boolean;
  shuffle?: number;
  repeat?: number;
  input_type_index: string;
  consecutive_failures: number;
  last_seen: number | null;
}

export interface DevicesResponse {
  devices: PlayerStatus[];
  discovered_at: number | null;
  discovery_method: string;
}

export interface PresenceDrop {
  device_id: string;
  name: string;
  started_at: number;
  ended_at: number | null;
  duration_seconds: number;
  peak_failures: number;
  slow_poll: boolean;
}

export interface FleetHealthResponse {
  started_at: number;
  observed_at: number;
  window_seconds: number;
  presence_window_seconds: number;
  circuit_failure_threshold: number;
  first_online: Record<string, number>;
  drops: PresenceDrop[];
}

export interface QueueItem {
  title: string;
  artist: string;
  album: string;
  image: string;
  service: string;
}

export interface QueueResponse {
  items: QueueItem[];
  count: number;
}

export interface AudioInput {
  name: string;
  type: string;
  id: string;
  selected: boolean;
}

export interface Preset {
  id: string;
  name: string;
  image: string;
}

export interface BluetoothResponse {
  supported: boolean;
  mode: string | null;
}

export interface SyncGroup {
  primary_id: string;
  primary_name: string;
  primary_ip: string;
  primary_endpoint?: string;
  group: string;
  slave_ids: string[];
  slave_names: string[];
}

export interface SyncState {
  groups: SyncGroup[];
  standalone_ids: string[];
}

export interface DiagnoseResponse {
  device_id: string;
  ip: string;
  /** BluOS API port (backend always includes; typically 11000). */
  port: number;
  name: string;
  model: string;
  full_model: string;
  device_class: string;
  mac: string;
  fw: string;
  state: string;
  service: string;
  volume: number;
  muted: boolean;
  db: string;
  sync_role: SyncRole;
  master: string;
  group: string;
  quality: string;
  stream_format: string;
  uptime: string | null;
  network_name: string | null;
  signal_strength: string | null;
  total_songs: string | null;
  web_ip: string | null;
  web_mac: string | null;
  web_fw: string | null;
}

export interface SettingOption {
  name: string;
  display_name: string;
}

export interface SettingDependency {
  name: string;
  value: string;
}

export interface DeviceSetting {
  id: string;
  name: string;
  display_name: string;
  kind: string;
  value: string;
  description: string;
  explanation: string;
  disabled: boolean;
  hide_if_disabled: boolean;
  control_path: string;
  min_value: number | null;
  max_value: number | null;
  min_range: number | null;
  step: number | null;
  units: string;
  pattern: string;
  pattern_error: string;
  refresh_after_write: boolean;
  options: SettingOption[];
  dependencies: SettingDependency[];
  depends_on: string;
  depends_value: string;
}

export interface DeviceSettingsResponse {
  page_id: string;
  settings: DeviceSetting[];
}

export interface UpgradeStatus {
  device_id: string;
  name: string;
  ip: string;
  current_fw: string;
  update_available: boolean;
  message: string;
  ok: boolean;
}

export interface FleetUpgradeResponse {
  updates_available: number;
  checked: number;
  failed: number;
  results: UpgradeStatus[];
}

export interface FirmwareEntry {
  device_id: string;
  name: string;
  ip: string;
  model: string;
  fw: string;
  status: string;
}

export interface FleetFirmwareResponse {
  unique_versions: string[];
  skew: boolean;
  devices: FirmwareEntry[];
}

export interface FleetActionResult {
  device_id: string;
  name: string;
  ok: boolean;
}

export interface FleetActionResponse {
  action: string;
  succeeded: number;
  failed: number;
  results: FleetActionResult[];
}

export interface ApiErrorBody {
  error: string;
  message: string;
  code: string;
  request_id: string;
}

export class ApiError extends Error {
  status: number;
  code: string;
  requestId: string;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message || body.error || 'Request failed');
    this.status = status;
    this.code = body.code || body.error || 'error';
    this.requestId = body.request_id || '-';
  }
}
