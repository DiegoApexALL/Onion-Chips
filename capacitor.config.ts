import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.onionchips.onioncost',
  appName: 'Onion Cost',
  webDir: 'dist',
  android: {
    backgroundColor: '#faf7f2',
  },
  plugins: {
    // Mantém o app abaixo da barra de status e acima da barra de navegação
    SystemBars: { insetsHandling: 'native' },
  },
}

export default config
