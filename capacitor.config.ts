import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.local.storescan',
  appName: '老于智慧仓管',
  webDir: 'dist',
  server: {
    androidScheme: 'http'
  }
};

export default config;
