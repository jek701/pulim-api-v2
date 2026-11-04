import { apnsConfigured } from './apns';
import { pushDevicesAvailable } from './devices.repository';

/** Keep Telegram available until both the provider and owner-installed registry are ready. */
export async function pushAvailable(): Promise<boolean> {
  return apnsConfigured() && await pushDevicesAvailable();
}
