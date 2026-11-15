// weaver-gui 仅提供 MyGo 原生桌面窗口；命令行 weaver 不依赖本包。
package main

import (
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
	"log"
)

func main() {
	a := newApp()
	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{Title: "Weaver", Width: 1280, Height: 820, Content: ui.View(a.view)})
		// X11 任务栏与标题栏读窗口图标；Wayland 按 app_id（weaver-gui）匹配桌面条目的 Icon。
		if err := win.SetIcon(brandIconPNG); err != nil {
			log.Printf("设置窗口图标失败：%v", err)
		}
		// app 的状态由互斥锁保护；Invalidate 是 views.md 规定的安全刷新方式。
		a.mu.Lock()
		a.invalidate = win.Invalidate
		a.mu.Unlock()
		win.OnClosed(a.close)
		a.start()
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
