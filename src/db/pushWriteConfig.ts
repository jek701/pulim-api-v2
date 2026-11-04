// Storage and migration tools must stay independent of application env validation.
let enabled = false;
export const pushWriteEventsEnabled = (): boolean => enabled;
export function setPushWriteEventsEnabled(value: boolean): void {
  enabled = value;
}
