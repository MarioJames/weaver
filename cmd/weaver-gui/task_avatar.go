package main

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"sync"

	"github.com/egoist/mygo/ui"
)

var taskAvatarPalette = [...]string{"#F2E8CF", "#386FA4", "#133C55", "#F4A259", "#BC4B51"}

var taskAvatarCache = struct {
	sync.Mutex
	images map[struct{ seed, avoid string }]*ui.SVG
}{images: make(map[struct{ seed, avoid string }]*ui.SVG)}

func taskAvatarBackground(seed, avoid string) int {
	h := sha256.Sum256([]byte(seed))
	index := int(h[0]) % len(taskAvatarPalette)
	if avoid != "" {
		other := sha256.Sum256([]byte(avoid))
		if index == int(other[0])%len(taskAvatarPalette) {
			index = (index + 1) % len(taskAvatarPalette)
		}
	}
	return index
}

func taskAvatarSource(seed, avoid string) string {
	h := sha256.Sum256([]byte(seed))
	var pal [5]string
	for i := range pal {
		pal[i] = taskAvatarPalette[(i+taskAvatarBackground(seed, avoid))%len(pal)]
	}
	if h[1]&1 == 1 {
		pal[1], pal[3] = pal[3], pal[1]
	}
	tx, ty, rotation := int(h[6]%24)-12, int(h[7]%24)-12, int(h[8])*360/256
	height := 10
	if h[9]&1 == 1 {
		height = 80
	}
	var b strings.Builder
	b.WriteString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="80" height="80">`)
	fmt.Fprintf(&b, `<rect width="80" height="80" fill="%s"/>`, pal[0])
	fmt.Fprintf(&b, `<rect x="10" y="30" width="80" height="%d" fill="%s" transform="translate(%d %d) rotate(%d 40 40)"/>`, height, pal[1], tx, ty, rotation)
	fmt.Fprintf(&b, `<circle cx="40" cy="40" r="16" fill="%s" transform="translate(%d %d)"/>`, pal[2], -ty, tx)
	fmt.Fprintf(&b, `<line x1="0" y1="40" x2="80" y2="40" stroke-width="3" stroke="%s" transform="translate(%d %d) rotate(%d 40 40)"/>`, pal[3], ty, -tx, rotation*2)
	b.WriteString(`</svg>`)
	return b.String()
}

func taskAvatarSVG(seed, avoid string) *ui.SVG {
	taskAvatarCache.Lock()
	defer taskAvatarCache.Unlock()
	key := struct{ seed, avoid string }{seed, avoid}
	if svg := taskAvatarCache.images[key]; svg != nil {
		return svg
	}
	svg := ui.MustParseSVG([]byte(taskAvatarSource(seed, avoid)))
	taskAvatarCache.images[key] = svg
	return svg
}

func taskAvatar(c *ui.Context, seed string, size float32) {
	taskAvatarAvoid(c, seed, "", size)
}

// taskAvatarAvoid advances a colliding background by one palette slot. Render
// the first participant normally and pass its seed as avoid for the second.
func taskAvatarAvoid(c *ui.Context, seed, avoid string, size float32) {
	ui.Image(c, taskAvatarSVG(seed, avoid)).Size(size, size).Shrink(0).Radius(size / 2)
}
