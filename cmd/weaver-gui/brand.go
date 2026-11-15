// 品牌素材：围巾图标与路径字标，取自 docs/assets/brand（见其 README「后台界面」）。
package main

import (
	_ "embed"

	"github.com/egoist/mygo/ui"
	"github.com/lobehub/lobe-mygo/pkg/theme"
)

// brandIconPNG 与 docs/assets/brand/weaver-icon-256.png 字节一致；窗口图标也用它。
//
//go:embed assets/weaver-icon.png
var brandIconPNG []byte

// 字标是界面组合 SVG 里的同一组路径，填色改为 currentColor 以随主题取色。
//
//go:embed assets/weaver-wordmark.svg
var brandWordmarkSVG []byte

var (
	brandIcon     = mustDecodeImage(brandIconPNG)
	brandWordmark = ui.MustParseSVG(brandWordmarkSVG)
	// 暖炭色字标（README「配色」）；深色主题下改用正文色，保证对比度。
	brandWordmarkLight = ui.Hex("#332B28")
)

func mustDecodeImage(data []byte) ui.ImageSource {
	img, err := ui.DecodeImage(data)
	if err != nil {
		panic(err)
	}
	return img
}

// brand 按界面组合的图文比例绘制：图标可见约 24 DIP、字标约 17 DIP，
// 以围巾图标为视觉重心；compact 时整体按 7/8 缩小。
func brand(c *ui.Context, compact bool) {
	tk := theme.TokensOf(c)
	icon, word, gap := float32(28), float32(17), float32(5)
	if compact {
		icon, word, gap = 24, 15, 4
	}
	color := brandWordmarkLight
	if tk.Dark {
		color = tk.Text
	}
	ui.Row(c).Gap(gap).AlignItems(ui.Center).Label("Weaver").Children(func() {
		ui.Image(c, brandIcon).Size(icon, icon).Shrink(0)
		ui.Icon(c, brandWordmark).FontSize(word).TextColor(color)
	})
}
