import './app/style.css';
import '@lobehub/ui/theme.css';
import '@lobehub/ui/style.css';
import '@lobehub/ui/global.css';

import { createRoot } from 'react-dom/client';
import { ConfigProvider, setLobeTheme } from '@lobehub/ui';
import { zhCn } from '@lobehub/ui/i18n';
import { motion } from 'motion/react';
import { App } from './app/App';
import { installBrowserClient } from './api/client';

// Light only. Cool slate neutrals with a geekblue accent; the canvas sits one step below the white cards.
setLobeTheme({ appearance: 'light', neutralColor: 'slate', primaryColor: 'geekblue' });

function Root() {
  return <ConfigProvider locale="zh-CN" motion={motion} resources={zhCn} enableCustomFonts={false}>
    <App />
  </ConfigProvider>;
}

installBrowserClient();
createRoot(document.getElementById('root')!).render(<Root />);
