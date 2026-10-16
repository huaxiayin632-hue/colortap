import type { DesktopAPI } from '../shared/ipc';
declare global {
  interface Window {
    desktop: DesktopAPI;
  }
}
export {};
