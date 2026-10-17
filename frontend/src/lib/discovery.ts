const DISCOVERY_LABEL: Record<string, string> = {
  both: 'mDNS + LSDP',
  mdns: 'mDNS',
  lsdp: 'LSDP',
  'mdns+lsdp': 'mDNS + LSDP',
};

/** Human label for the backend's discovery method; unknown methods pass through. */
export function discoveryLabel(method: string): string {
  return DISCOVERY_LABEL[method] ?? method;
}

export function playerCountLabel(count: number): string {
  return count === 1 ? '1 player' : `${count} players`;
}
