import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.alsayyad.transport',
  appName: 'نقليات الصياد',
  webDir: 'dist',
  android: {
    useLegacyBridge: true
  }
};

export default config;
