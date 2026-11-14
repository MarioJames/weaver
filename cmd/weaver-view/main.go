// weaver-view 是 Weaver 2 只读运行视图的技术验证雏形：同一份视图代码编成桌面窗口和 WASM。
package main

import (
	"log"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func main() {
	a := newApp(2000)
	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{Title: "Weaver 2 运行视图", Width: 1280, Height: 820, Content: ui.View(a.view)})
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
