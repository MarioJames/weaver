package main

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"
)

// 运行时图标是品牌目录 256 px 图标的副本，换品牌时两边必须一起改。
func TestBrandIconMatchesBrandAsset(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "docs", "assets", "brand", "weaver-icon-256.png"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(source, brandIconPNG) {
		t.Fatal("cmd/weaver-gui/assets/weaver-icon.png 与 docs/assets/brand/weaver-icon-256.png 不一致")
	}
}

// 侧栏与窄窗口顶栏都画围巾图标和路径字标，不再是「W」方块加普通字体。
// WEAVER_POLISH_SCREENSHOTS 设置时另存浅色与深色截图。
func TestBrandShowsLogoAssets(t *testing.T) {
	a := testApp(t, newTasksFake(t).fakeService)
	tt := ui.NewTester(a.view, 1280, 820)
	dir := os.Getenv("WEAVER_POLISH_SCREENSHOTS")
	for _, tc := range []struct {
		name          string
		width, height int
		dark          bool
	}{
		{"brand-light-1280", 1280, 820, false},
		{"brand-dark-1280", 1280, 820, true},
		{"brand-light-860", 860, 820, false},
		{"brand-dark-860", 860, 820, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tt.SetDark(tc.dark)
			tt.SetSize(tc.width, tc.height)
			tt.Frame()
			if slices.Contains(tt.Texts(), "W") {
				t.Fatalf("仍显示「W」占位：%q", tt.Texts())
			}
			box, ok := tt.Find("Weaver")
			if !ok {
				t.Fatalf("找不到品牌区域：%q", tt.Texts())
			}
			img := tt.Image()
			if !hasCoral(img, box) {
				t.Fatalf("品牌区域 %v 内没有围巾图标的珊瑚色", box)
			}
			if dir != "" {
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				file, err := os.Create(filepath.Join(dir, tc.name+".png"))
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
				if err := png.Encode(file, img); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

// hasCoral 报告 box（DIP）内是否有图标的暖珊瑚色像素。
func hasCoral(img *image.RGBA, box ui.Rect) bool {
	for y := int(box.Y); y < int(box.Y+box.H); y++ {
		for x := int(box.X); x < int(box.X+box.W); x++ {
			c := img.RGBAAt(x, y)
			if c.R > 200 && c.G > 60 && c.G < 150 && c.B < 140 {
				return true
			}
		}
	}
	return false
}
