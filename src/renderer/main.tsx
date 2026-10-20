import { createRoot } from 'react-dom/client';
import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { slate } from '@lobehub/ui/color';
import { zhCn } from '@lobehub/ui/i18n';
import { motion } from 'motion/react';
import { App } from './app/App';
import { installBrowserClient } from './api/client';
import './app/style.css';

// Light only. Cool slate neutrals with a geekblue accent; the canvas sits one step below the white cards.
const surface = { colorBgLayout: slate.light[1], colorBgContainer: slate.light[0], colorBgElevated: slate.light[0] };

function Root() {
  return <ConfigProvider locale="zh-CN" motion={motion} resources={zhCn}>
    <ThemeProvider themeMode="light" enableCustomFonts={false} customTheme={{ neutralColor: 'slate', primaryColor: 'geekblue' }} customToken={() => surface} style={{ height: '100%' }}>
      <App />
    </ThemeProvider>
  </ConfigProvider>;
}

installBrowserClient();
createRoot(document.getElementById('root')!).render(<Root />);
