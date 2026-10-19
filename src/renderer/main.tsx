import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { sage } from '@lobehub/ui/color';
import { zhCn } from '@lobehub/ui/i18n';
import { motion } from 'motion/react';
import { App } from './App';
import { installBrowserClient } from './client';
import { styles } from './style';
import './style.css';

function sageSurface(isDark: boolean) {
  const scale = sage[isDark ? 'dark' : 'light'];
  const surface = scale[1];
  const primary = scale[isDark ? 7 : 11];
  return {
    colorBgLayout: surface,
    colorBgContainer: surface,
    colorBgElevated: scale[isDark ? 2 : 0],
    colorPrimary: primary,
    colorPrimaryHover: scale[isDark ? 8 : 10],
    colorPrimaryActive: scale[isDark ? 6 : 11],
    colorPrimaryBg: scale[isDark ? 3 : 2],
    colorPrimaryBorder: scale[isDark ? 6 : 9],
    colorPrimaryText: scale[isDark ? 11 : 11],
    colorTextLightSolid: scale[isDark ? 12 : 0],
  };
}

function Root() {
  const [mode, setMode] = useState<'light' | 'dark'>(() => window.localStorage.getItem('weaver-theme') === 'light' ? 'light' : 'dark');
  useEffect(() => { window.localStorage.setItem('weaver-theme', mode); }, [mode]);
  return <ConfigProvider locale="zh-CN" motion={motion} resources={zhCn}>
    <ThemeProvider className={styles.app} style={{ display: 'flex', flex: '1 1 auto', flexDirection: 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0 }} themeMode={mode} enableCustomFonts={false} customTheme={{ neutralColor: 'sage', primaryColor: 'green' }} customToken={theme => sageSurface(theme.isDarkMode)}>
      <App mode={mode} onMode={setMode} />
    </ThemeProvider>
  </ConfigProvider>;
}

installBrowserClient();
createRoot(document.getElementById('root')!).render(<Root />);
